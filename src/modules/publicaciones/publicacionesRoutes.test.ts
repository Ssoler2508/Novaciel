import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { assignRole, createActores, createPiezaAprobable, createPublicacion, createUsuario } from '../../../tests/utils/factories/index.js';
import { createPiezaProgramada, SECRETO_FICTICIO, type PiezaProgramada } from '../../../tests/utils/publicacionWorld.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { FakePublishProvider } from '../../lib/publish/fakePublishProvider.js';
import { registrarDecision } from '../aprobaciones/aprobacionesService.js';
import { FakeRecordatorios } from '../aprobaciones/recordatoriosPort.js';
import { registerAuth } from '../auth/authRoutes.js';
import type { RoleCode } from '../auth/permissions.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import { ejecutarJobPublicar, ejecutarRecoleccionMetricas } from './publicacionesJobs.js';
import { FakePublicacionQueue } from './publicacionQueue.js';
import { registerPublicacionesRoutes } from './publicacionesRoutes.js';

// One test-transaction client as Db, app.inject(), rollback. Queue and recordatorios are fakes; storage is FakeStorage.

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];
const DIA = 86_400_000;
const H = 3_600_000;

interface Ctx {
  app: ReturnType<typeof Fastify>;
  db: Db;
  storage: FakeStorage;
  queue: FakePublicacionQueue;
  recordatorios: FakeRecordatorios;
  logs: string[];
}

async function withApp(fn: (ctx: Ctx) => Promise<void>) {
  await withTestTransaction(async (db) => {
    const logs: string[] = [];
    const app = Fastify({ loggerInstance: createLogger('debug', { write: (l: string) => void logs.push(l) }) });
    const storage = new FakeStorage();
    const queue = new FakePublicacionQueue();
    const recordatorios = new FakeRecordatorios();
    await registerAuth(app, { db, allowedOrigin: ORIGIN });
    await registerPublicacionesRoutes(app, { db, storage, recordatorios, publicaciones: queue });
    try {
      await fn({ app, db, storage, queue, recordatorios, logs });
    } finally {
      await app.close();
    }
  });
}

async function login(ctx: Ctx, rol: RoleCode, clienteId: string | null) {
  const user = await createUsuario(ctx.db, { password: PASSWORD });
  await assignRole(ctx.db, { usuarioId: user.id, rolCodigo: rol, clienteId: NOVACIEL.includes(rol) ? null : clienteId });
  const res = await ctx.app.inject({ method: 'POST', url: '/auth/login', headers: JSON_HEADERS, payload: { email: user.email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return { user, headers: { cookie: String(res.headers['set-cookie']).split(';')[0]! } };
}
type Session = Awaited<ReturnType<typeof login>>;

const send = (ctx: Ctx, method: 'POST' | 'PUT', s: Session | null, url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { ...JSON_HEADERS, ...(s?.headers ?? {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const get = (ctx: Ctx, s: Session | null, url: string) => ctx.app.inject({ method: 'GET', url, headers: s?.headers ?? {} });

const progUrl = (clienteId: string, piezaId: string) => `/clientes/${clienteId}/piezas/${piezaId}/programacion`;
const enDias = (n: number) => new Date(Date.now() + n * DIA).toISOString();

/** A piece approved at both levels (`aprobada`), not yet scheduled, in the context's storage. */
async function aprobada(ctx: Ctx) {
  const w = await createPiezaAprobable(ctx.db, ctx.storage);
  const actores = await createActores(ctx.db, w.clienteId);
  const clienteId = asClienteId(w.clienteId);
  await registrarDecision({ db: ctx.db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
  await registrarDecision({ db: ctx.db }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex });
  return { w, clienteId };
}

describe('scheduling routes', () => {
  it('POST schedules an approved piece: programada, the time saved, the send queued in the same call, the reminders queued', async () => {
    await withApp(async (ctx) => {
      const x = await aprobada(ctx);
      const op = await login(ctx, 'operador_novaciel', null);
      const cuando = enDias(3);
      const res = await send(ctx, 'POST', op, progUrl(x.w.clienteId, x.w.piezaId), { fecha_hora: cuando });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pieza_id: x.w.piezaId, estado: 'programada', fecha_hora: cuando });
      expect(ctx.queue.programados).toHaveLength(1);
      expect(ctx.queue.programados[0]!.payload).toEqual({ clienteId: x.w.clienteId, piezaId: x.w.piezaId, produccionId: x.w.produccionId, fechaHora: cuando, ronda: 0 });
      expect(ctx.recordatorios.programados).toHaveLength(1);
      const audit = await ctx.db.query(`SELECT actor_usuario_id FROM auditoria WHERE accion = 'programar_pieza' AND fila_id = $1`, [x.w.piezaId]);
      expect(audit.rows).toEqual([{ actor_usuario_id: op.user.id }]);
    });
  });

  it('PUT reschedules; POST cancelar returns the piece to con_cambios and queues nothing', async () => {
    await withApp(async (ctx) => {
      const x = await aprobada(ctx);
      const admin = await login(ctx, 'administrador_novaciel', null);
      expect((await send(ctx, 'POST', admin, progUrl(x.w.clienteId, x.w.piezaId), { fecha_hora: enDias(3) })).statusCode).toBe(200);
      const nuevo = enDias(5);
      const put = await send(ctx, 'PUT', admin, progUrl(x.w.clienteId, x.w.piezaId), { fecha_hora: nuevo });
      expect(put.statusCode).toBe(200);
      expect(put.json().fecha_hora).toBe(nuevo);
      expect(ctx.queue.programados.map((p) => p.payload.fechaHora)).toEqual([expect.any(String), nuevo]);
      expect(ctx.recordatorios.programados).toHaveLength(2);

      const antes = ctx.queue.programados.length;
      const cancel = await send(ctx, 'POST', admin, `${progUrl(x.w.clienteId, x.w.piezaId)}/cancelar`, { motivo: 'el cliente cambió el menú' });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json().estado).toBe('con_cambios');
      expect(ctx.queue.programados).toHaveLength(antes);
      const again = await send(ctx, 'POST', admin, `${progUrl(x.w.clienteId, x.w.piezaId)}/cancelar`, { motivo: 'otra vez' });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'estado_invalido', estado: 'con_cambios' });
    });
  });

  it('answers with the permissions of schedule_pieces: NovaCiel only, per client, with a session', async () => {
    await withApp(async (ctx) => {
      const x = await aprobada(ctx);
      const otro = await aprobada(ctx);
      const url = progUrl(x.w.clienteId, x.w.piezaId);
      const body = { fecha_hora: enDias(3) };
      expect((await send(ctx, 'POST', null, url, body)).statusCode).toBe(401);
      for (const rol of ['dueno_cliente', 'aprobador_cliente', 'colaborador_cliente'] as const) {
        const s = await login(ctx, rol, x.w.clienteId);
        expect((await send(ctx, 'POST', s, url, body)).statusCode, rol).toBe(403);
        expect((await send(ctx, 'PUT', s, url, body)).statusCode, rol).toBe(403);
        expect((await send(ctx, 'POST', s, `${url}/cancelar`, { motivo: 'x' })).statusCode, rol).toBe(403);
      }
      // A client owner of ANOTHER client is refused too.
      const ajeno = await login(ctx, 'dueno_cliente', otro.w.clienteId);
      expect((await send(ctx, 'POST', ajeno, url, body)).statusCode).toBe(403);
      expect((await getPieza(ctx.db, x.clienteId, x.w.piezaId))!.estado).toBe('aprobada');
    });
  });

  it('validates the body, the time and the ids; refuses a piece that is not publishable with the reason', async () => {
    await withApp(async (ctx) => {
      const x = await aprobada(ctx);
      const op = await login(ctx, 'operador_novaciel', null);
      const url = progUrl(x.w.clienteId, x.w.piezaId);
      expect((await send(ctx, 'POST', op, url, {})).statusCode).toBe(400);
      expect((await send(ctx, 'POST', op, url, { fecha_hora: 'mañana' })).statusCode).toBe(400);
      expect((await send(ctx, 'POST', op, url, { fecha_hora: enDias(3), extra: 1 })).statusCode).toBe(400);
      const pasado = await send(ctx, 'POST', op, url, { fecha_hora: new Date(Date.now() - H).toISOString() });
      expect(pasado.statusCode).toBe(400);
      expect(pasado.json()).toEqual({ error: 'programacion_invalida', motivos: ['fecha_pasada'] });
      expect((await send(ctx, 'POST', op, progUrl(x.w.clienteId, 'no-es-uuid'), { fecha_hora: enDias(3) })).statusCode).toBe(404);
      expect((await send(ctx, 'POST', op, progUrl(x.w.clienteId, '00000000-0000-4000-8000-000000000000'), { fecha_hora: enDias(3) })).statusCode).toBe(404);
      // The piece of another client is not found through this client's path.
      const otro = await aprobada(ctx);
      expect((await send(ctx, 'POST', op, progUrl(otro.w.clienteId, x.w.piezaId), { fecha_hora: enDias(3) })).statusCode).toBe(404);

      // A stored file changed: the gate refuses, with codes only.
      await ctx.storage.put(x.w.claves[0]!, Buffer.from('alterado'), 'image/jpeg');
      const res = await send(ctx, 'POST', op, url, { fecha_hora: enDias(3) });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'archivo_alterado', orden: 1, motivo: expect.any(String) });
      expect((await getPieza(ctx.db, x.clienteId, x.w.piezaId))!.estado).toBe('aprobada');
      expect(ctx.queue.programados).toEqual([]);
    });
  });
});

describe('publication history and results', () => {
  /** A published piece with its metrics collected, in the context's storage. */
  async function publicada(ctx: Ctx): Promise<PiezaProgramada> {
    const p = await createPiezaProgramada(ctx.db, { storage: ctx.storage, secreto: SECRETO_FICTICIO });
    const provider = new FakePublishProvider();
    const deps = { db: ctx.db, storage: ctx.storage, provider, queue: ctx.queue };
    const pieza = (await getPieza(ctx.db, p.clienteId, p.w.piezaId))!;
    await ejecutarJobPublicar(deps, { clienteId: p.w.clienteId, piezaId: p.w.piezaId, produccionId: p.w.produccionId, fechaHora: pieza.fecha_hora.toISOString(), ronda: 0 });
    await ejecutarRecoleccionMetricas(deps, new Date(Date.now() + 25 * H));
    return p;
  }

  it('GET publicaciones lists the attempts with their state, link and no credential; client roles can read it', async () => {
    await withApp(async (ctx) => {
      const p = await publicada(ctx);
      const dueno = await login(ctx, 'dueno_cliente', p.w.clienteId);
      const res = await get(ctx, dueno, `/clientes/${p.w.clienteId}/piezas/${p.w.piezaId}/publicaciones`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.pieza_estado).toBe('en_medicion');
      expect(body.intentos).toHaveLength(1);
      expect(body.intentos[0]).toMatchObject({ numero_intento: 1, proveedor: 'fake', red: 'instagram', estado: 'publicada', categoria_error: null, etiqueta_ia: false });
      expect(body.intentos[0].enlace).toMatch(/^https:\/\//);
      expect(res.payload).not.toContain(SECRETO_FICTICIO);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  it('GET publicaciones shows an attempt without a result as "enviando"', async () => {
    await withApp(async (ctx) => {
      const p = await createPiezaProgramada(ctx.db, { storage: ctx.storage });
      await createPublicacion(ctx.db, { piezaId: p.w.piezaId });
      const op = await login(ctx, 'operador_novaciel', null);
      const res = await get(ctx, op, `/clientes/${p.w.clienteId}/piezas/${p.w.piezaId}/publicaciones`);
      expect(res.json().intentos.map((i: { estado: string }) => i.estado)).toEqual(['enviando']);
    });
  });

  it('GET resultados of a piece returns its snapshots; of a piece never published, none', async () => {
    await withApp(async (ctx) => {
      const p = await publicada(ctx);
      const q = await createPiezaProgramada(ctx.db, { storage: ctx.storage });
      const aprob = await login(ctx, 'aprobador_cliente', p.w.clienteId);
      const res = await get(ctx, aprob, `/clientes/${p.w.clienteId}/piezas/${p.w.piezaId}/resultados`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ publicada: true, snapshots: [{ ventana: '24h', metricas: { alcance: expect.any(Number), retencion_pct: expect.any(Number) } }] });
      const op = await login(ctx, 'operador_novaciel', null);
      const vacia = await get(ctx, op, `/clientes/${q.w.clienteId}/piezas/${q.w.piezaId}/resultados`);
      expect(vacia.json()).toMatchObject({ publicada: false, publicada_en: null, snapshots: [] });
    });
  });

  it('GET resultados of a week gives the published pieces with their latest snapshot and totals that never turn "unknown" into 0', async () => {
    await withApp(async (ctx) => {
      const p = await publicada(ctx);
      const semana = (await ctx.db.query<{ s: string }>('SELECT semana_inicio::text AS s FROM planes_semanales WHERE id = $1', [p.w.planId])).rows[0]!.s;
      const dueno = await login(ctx, 'dueno_cliente', p.w.clienteId);
      const res = await get(ctx, dueno, `/clientes/${p.w.clienteId}/resultados?semana=${semana}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.semana).toBe(semana);
      expect(body.piezas).toHaveLength(1);
      expect(body.piezas[0]).toMatchObject({ pieza_id: p.w.piezaId, red: 'instagram', ventana: '24h' });
      expect(body.totales).toMatchObject({ piezas_publicadas: 1, piezas_con_metricas: 1, alcance: body.piezas[0].metricas.alcance });

      // A week with nothing published: zero pieces and every total unknown (null), not 0.
      const vacia = await get(ctx, dueno, `/clientes/${p.w.clienteId}/resultados?semana=2020-01-06`);
      expect(vacia.json().totales).toMatchObject({ piezas_publicadas: 0, alcance: null, me_gusta: null });
      for (const mala of ['', '?semana=ayer', '?semana=2026-13-45', '?semana=2026-11-02&x=1']) {
        expect((await get(ctx, dueno, `/clientes/${p.w.clienteId}/resultados${mala}`)).statusCode, mala).toBe(400);
      }
    });
  });

  it('keeps clients apart and refuses roles without read access', async () => {
    await withApp(async (ctx) => {
      const p = await publicada(ctx);
      const otro = await createPiezaProgramada(ctx.db, { storage: ctx.storage });
      const ajeno = await login(ctx, 'dueno_cliente', otro.w.clienteId);
      const colab = await login(ctx, 'colaborador_cliente', p.w.clienteId);
      const op = await login(ctx, 'operador_novaciel', null);
      for (const url of [
        `/clientes/${p.w.clienteId}/piezas/${p.w.piezaId}/publicaciones`,
        `/clientes/${p.w.clienteId}/piezas/${p.w.piezaId}/resultados`,
        `/clientes/${p.w.clienteId}/resultados?semana=2026-11-02`,
      ]) {
        expect((await get(ctx, null, url)).statusCode).toBe(401);
        expect((await get(ctx, ajeno, url)).statusCode, url).toBe(403);
        expect((await get(ctx, colab, url)).statusCode, url).toBe(403);
      }
      // Through the other client's path, the piece does not exist.
      expect((await get(ctx, op, `/clientes/${otro.w.clienteId}/piezas/${p.w.piezaId}/publicaciones`)).statusCode).toBe(404);
      expect((await get(ctx, op, `/clientes/${otro.w.clienteId}/piezas/${p.w.piezaId}/resultados`)).statusCode).toBe(404);
      // And the week of the other client shows none of this client's pieces.
      const semana = (await ctx.db.query<{ s: string }>('SELECT semana_inicio::text AS s FROM planes_semanales WHERE id = $1', [p.w.planId])).rows[0]!.s;
      expect((await get(ctx, op, `/clientes/${otro.w.clienteId}/resultados?semana=${semana}`)).json().piezas).toEqual([]);
    });
  });

  it('never logs a credential or a caption', async () => {
    await withApp(async (ctx) => {
      const p = await publicada(ctx);
      const op = await login(ctx, 'operador_novaciel', null);
      await get(ctx, op, `/clientes/${p.w.clienteId}/piezas/${p.w.piezaId}/publicaciones`);
      await get(ctx, op, `/clientes/${p.w.clienteId}/piezas/${p.w.piezaId}/resultados`);
      expect(ctx.logs.join('')).not.toContain(SECRETO_FICTICIO);
      expect(ctx.logs.join('')).not.toContain('Texto de publicación ficticio');
    });
  });
});
