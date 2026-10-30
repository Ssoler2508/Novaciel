import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { assignRole, createCliente, createUsuario } from '../../../tests/utils/factories/index.js';
import { producibleWorld, type ProducibleWorld } from '../../../tests/utils/produccionWorld.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { registerAprobacionesRoutes } from '../aprobaciones/aprobacionesRoutes.js';
import { registerAuth } from '../auth/authRoutes.js';
import type { RoleCode } from '../auth/permissions.js';
import { getProduccionActual, producirPieza } from '../produccion/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { singletonKeyControlCalidad, type ControlCalidadPayload, type ControlCalidadQueue } from './controlCalidadJobs.js';
import { registerControlCalidadRoutes } from './controlCalidadRoutes.js';
import { ejecutarQC } from './ejecutarQC.js';

// Same pattern as produccionRoutes.test.ts: one test-transaction client as Db, app.inject(), rollback.
// The queue is a fake (the real pg-boss is in controlCalidadJobs.test.ts); storage is a FakeStorage.

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];
const SISTEMA = { tipo: 'sistema' } as const;
const COPY = 'Hecho con calma'; // a piece of the copy of the fictional piece

class FakeQueue implements ControlCalidadQueue {
  readonly jobs: ControlCalidadPayload[] = [];
  readonly busy = new Set<string>();
  async enqueue(payload: ControlCalidadPayload): Promise<string | null> {
    const key = singletonKeyControlCalidad(payload.clienteId, payload.produccionId);
    if (this.busy.has(key)) return null;
    this.busy.add(key);
    this.jobs.push(payload);
    return randomUUID();
  }
}

interface Ctx {
  app: ReturnType<typeof Fastify>;
  db: Db;
  queue: FakeQueue;
  logs: string[];
  w: ProducibleWorld;
}

async function withApp(fn: (ctx: Ctx) => Promise<void>) {
  await withTestTransaction(async (db) => {
    const logs: string[] = [];
    const app = Fastify({ loggerInstance: createLogger('debug', { write: (l: string) => void logs.push(l) }) });
    const queue = new FakeQueue();
    const w = await producibleWorld(db, { sinCifras: true });
    await registerAuth(app, { db, allowedOrigin: ORIGIN });
    await registerControlCalidadRoutes(app, { db, queue });
    await registerAprobacionesRoutes(app, { db, storage: w.storage });
    try {
      await fn({ app, db, queue, logs, w });
    } finally {
      await app.close();
    }
  });
}

async function login(ctx: Ctx, rol: RoleCode, clienteId: string | null = ctx.w.clienteId) {
  const user = await createUsuario(ctx.db, { password: PASSWORD });
  await assignRole(ctx.db, { usuarioId: user.id, rolCodigo: rol, clienteId: NOVACIEL.includes(rol) ? null : clienteId });
  const res = await ctx.app.inject({ method: 'POST', url: '/auth/login', headers: JSON_HEADERS, payload: { email: user.email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return { user, headers: { cookie: String(res.headers['set-cookie']).split(';')[0]! } };
}
type Session = Awaited<ReturnType<typeof login>>;

const post = (ctx: Ctx, s: Session | null, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { ...JSON_HEADERS, ...(s?.headers ?? {}), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const get = (ctx: Ctx, s: Session | null, url: string) => ctx.app.inject({ method: 'GET', url, headers: s?.headers ?? {} });

const qcUrl = (ctx: Ctx, piezaId = ctx.w.piezaId, clienteId: string = ctx.w.clienteId) => `/clientes/${clienteId}/piezas/${piezaId}/control-calidad`;
const revisionUrl = (ctx: Ctx) => `/clientes/${ctx.w.clienteId}/piezas/${ctx.w.piezaId}/revision`;
const produce = (ctx: Ctx) => producirPieza({ db: ctx.db, storage: ctx.w.storage }, ctx.w.clienteId, ctx.w.piezaId, SISTEMA);
/** Same size, other last byte: the file is still a valid image but is no longer the one that was produced. */
async function cambiarUnArchivo(ctx: Ctx, clave: string) {
  const actual = await ctx.w.storage.get(clave);
  await ctx.w.storage.put(clave, Buffer.concat([actual.subarray(0, actual.length - 1), Buffer.from([(actual[actual.length - 1]! + 1) % 256])]));
}
const controlar = (ctx: Ctx) => ejecutarQC({ db: ctx.db, storage: ctx.w.storage }, ctx.w.clienteId, ctx.w.piezaId, SISTEMA);

describe('GET .../piezas/:piezaId/control-calidad', () => {
  it('returns the latest report of the current production, with fixed Spanish reasons and no client text', async () => {
    await withApp(async (ctx) => {
      const produccion = (await produce(ctx)).produccion;
      const { revision } = await controlar(ctx);
      const admin = await login(ctx, 'administrador_novaciel');
      const res = await get(ctx, admin, qcUrl(ctx));
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        pieza_estado: 'revision_novaciel',
        vigente: true,
        informe: {
          id: revision.id,
          produccion_id: produccion.id,
          version: 1,
          hash_version: 'np1',
          hash_pieza: produccion.hash_pieza,
          resultado: 'aprobado',
          codigos_fallo: [],
          codigos_advertencia: [],
          actor_tipo: 'sistema',
        },
      });
      expect(body.informe.checks.length).toBeGreaterThan(10);
      expect(body.informe.checks[0]).toEqual({ codigo: expect.any(String), resultado: expect.any(String), severidad: expect.any(String), motivo: expect.any(String), parametros: expect.any(Object) });
      expect(res.body).not.toContain(COPY);
      expect(res.headers['cache-control']).toBe('no-store');
      // The operator reads it too.
      expect((await get(ctx, await login(ctx, 'operador_novaciel'), qcUrl(ctx))).statusCode).toBe(200);
    });
  });

  it('shows the failed codes of a rejected piece', async () => {
    await withApp(async (ctx) => {
      const { produccion } = await produce(ctx);
      await cambiarUnArchivo(ctx, produccion.archivos.find((a) => a.orden === 2)!.clave_almacenamiento);
      await controlar(ctx);
      const admin = await login(ctx, 'administrador_novaciel');
      const body = (await get(ctx, admin, qcUrl(ctx))).json();
      expect(body).toMatchObject({ pieza_estado: 'en_produccion', vigente: true, informe: { resultado: 'rechazado' } });
      expect(body.informe.codigos_fallo).toContain('archivo_hash_distinto');
    });
  });

  it('answers 200 with informe null and vigente false when the piece has no report, or only a report of an old production', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      // Not produced yet.
      expect((await get(ctx, admin, qcUrl(ctx))).json()).toEqual({ pieza_estado: 'guion_listo', vigente: false, informe: null });
      // Produced, not controlled yet.
      await produce(ctx);
      expect((await get(ctx, admin, qcUrl(ctx))).json()).toEqual({ pieza_estado: 'en_control_calidad', vigente: false, informe: null });
      // Rejected (a stored file is gone), then produced again: the report of version 1 is about another production.
      await cambiarUnArchivo(ctx, (await getProduccionActual(ctx.db, ctx.w.clienteId, ctx.w.piezaId))!.archivos[1]!.clave_almacenamiento);
      expect((await controlar(ctx)).revision.resultado).toBe('rechazado');
      await producirPieza({ db: ctx.db, storage: ctx.w.storage }, ctx.w.clienteId, ctx.w.piezaId, SISTEMA, { reproducir: true });
      expect((await get(ctx, admin, qcUrl(ctx))).json()).toEqual({ pieza_estado: 'en_control_calidad', vigente: false, informe: null });
    });
  });

  it('answers 404 for a piece that does not exist, belongs to another client or has a discarded plan', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const notFound = { error: 'not_found' };
      for (const url of [qcUrl(ctx, randomUUID()), qcUrl(ctx, 'no-es-un-uuid')]) {
        const res = await get(ctx, admin, url);
        expect([res.statusCode, res.json()]).toEqual([404, notFound]);
      }
      // Another client's piece, asked under THIS client's id.
      const foreign = await producibleWorld(ctx.db);
      expect((await get(ctx, admin, qcUrl(ctx, foreign.piezaId))).statusCode).toBe(404);
      expect((await get(ctx, admin, qcUrl(ctx, ctx.w.piezaId, foreign.clienteId))).statusCode).toBe(404);

      await ctx.db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1 AND cliente_id = $2`, [ctx.w.planId, ctx.w.clienteId]);
      expect((await get(ctx, admin, qcUrl(ctx))).statusCode).toBe(404);
    });
  });

  it('is for NovaCiel only: the client roles and strangers get 403, anonymous callers 401', async () => {
    await withApp(async (ctx) => {
      const other = asClienteId((await createCliente(ctx.db)).id);
      for (const s of [await login(ctx, 'dueno_cliente'), await login(ctx, 'aprobador_cliente'), await login(ctx, 'colaborador_cliente'), await login(ctx, 'dueno_cliente', other)]) {
        expect((await get(ctx, s, qcUrl(ctx))).statusCode).toBe(403);
      }
      expect((await get(ctx, null, qcUrl(ctx))).statusCode).toBe(401);
    });
  });
});

describe('POST .../piezas/:piezaId/control-calidad', () => {
  it('queues a run for a piece waiting in en_control_calidad and answers 202; a second request is ya_en_cola', async () => {
    await withApp(async (ctx) => {
      const { produccion } = await produce(ctx);
      const admin = await login(ctx, 'administrador_novaciel');
      const res = await post(ctx, admin, qcUrl(ctx), {});
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ job_id: expect.stringMatching(/^[0-9a-f-]{36}$/), pieza_id: ctx.w.piezaId });
      expect(ctx.queue.jobs).toEqual([{ clienteId: ctx.w.clienteId, piezaId: ctx.w.piezaId, produccionId: produccion.id }]);
      expect(res.headers['cache-control']).toBe('no-store');
      const second = await post(ctx, admin, qcUrl(ctx), {});
      expect([second.statusCode, second.json()]).toEqual([409, { error: 'ya_en_cola' }]);
      expect(ctx.queue.jobs).toHaveLength(1);
      // An empty body is fine; unknown fields are not.
      expect((await post(ctx, await login(ctx, 'operador_novaciel'), qcUrl(ctx))).statusCode).toBe(409);
      expect((await post(ctx, admin, qcUrl(ctx), { otro: true })).statusCode).toBe(400);
    });
  });

  it('refuses with codes and queues nothing: wrong state, missing piece, foreign piece, discarded plan', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const refuse = async (url: string, status: number, body: unknown) => {
        const res = await post(ctx, admin, url, {});
        expect([res.statusCode, res.json()]).toEqual([status, body]);
      };
      await refuse(qcUrl(ctx), 409, { error: 'estado_invalido', estado: 'guion_listo' });
      await refuse(qcUrl(ctx, randomUUID()), 404, { error: 'not_found' });
      await refuse(qcUrl(ctx, 'no-es-un-uuid'), 404, { error: 'not_found' });
      const foreign = await producibleWorld(ctx.db);
      await refuse(qcUrl(ctx, foreign.piezaId), 404, { error: 'not_found' });

      await produce(ctx);
      await controlar(ctx); // revision_novaciel: nothing left to control
      await refuse(qcUrl(ctx), 409, { error: 'estado_invalido', estado: 'revision_novaciel' });

      await ctx.db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1 AND cliente_id = $2`, [ctx.w.planId, ctx.w.clienteId]);
      await refuse(qcUrl(ctx), 404, { error: 'not_found' }); // a piece of a discarded plan is hidden
      expect(ctx.queue.jobs).toHaveLength(0);
    });
  });

  it('follows the matrix and the CSRF guard: nothing is queued for the client roles, strangers or anonymous callers', async () => {
    await withApp(async (ctx) => {
      await produce(ctx);
      const other = asClienteId((await createCliente(ctx.db)).id);
      for (const s of [await login(ctx, 'dueno_cliente'), await login(ctx, 'aprobador_cliente'), await login(ctx, 'colaborador_cliente'), await login(ctx, 'dueno_cliente', other)]) {
        expect((await post(ctx, s, qcUrl(ctx), {})).statusCode).toBe(403);
      }
      expect((await post(ctx, null, qcUrl(ctx), {})).statusCode).toBe(401);
      const admin = await login(ctx, 'administrador_novaciel');
      expect((await ctx.app.inject({ method: 'POST', url: qcUrl(ctx), headers: { ...admin.headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await post(ctx, admin, qcUrl(ctx), {}, { origin: 'http://evil.example' })).statusCode).toBe(403);
      expect(ctx.queue.jobs).toHaveLength(0);
    });
  });
});

describe('the control_calidad field of GET .../piezas/:piezaId/revision (additive)', () => {
  it('is null while the current production has no report', async () => {
    await withApp(async (ctx) => {
      await produce(ctx);
      const body = (await get(ctx, await login(ctx, 'administrador_novaciel'), revisionUrl(ctx))).json();
      expect(body.control_calidad).toBeNull();
      // The rest of the view is untouched.
      expect(body).toMatchObject({ version: 1, pieza_estado: 'en_control_calidad' });
      expect(Object.keys(body)).toEqual(expect.arrayContaining(['archivos', 'pieza_estado', 'fecha_hora', 'estado_aprobacion', 'historial', 'control_calidad']));
    });
  });

  it('gives NovaCiel the result, version, date and the codes; the client roles the result, version and date only', async () => {
    await withApp(async (ctx) => {
      const { produccion } = await produce(ctx);
      await cambiarUnArchivo(ctx, produccion.archivos.find((a) => a.orden === 2)!.clave_almacenamiento);
      const { revision } = await controlar(ctx);
      expect(revision.resultado).toBe('rechazado');

      const novaciel = (await get(ctx, await login(ctx, 'operador_novaciel'), revisionUrl(ctx))).json().control_calidad;
      expect(novaciel).toEqual({ resultado: 'rechazado', version: 1, creado_en: revision.creado_en.toISOString(), codigos_fallo: revision.codigos_fallo, codigos_advertencia: [] });
      expect(novaciel.codigos_fallo).toContain('archivo_hash_distinto');

      for (const rol of ['dueno_cliente', 'aprobador_cliente'] as const) {
        const res = await get(ctx, await login(ctx, rol), revisionUrl(ctx));
        expect(res.statusCode).toBe(200);
        expect(res.json().control_calidad, rol).toEqual({ resultado: 'rechazado', version: 1, creado_en: revision.creado_en.toISOString() });
        expect(res.body).not.toContain('archivo_hash_distinto');
      }
      // colaborador_cliente cannot read the view at all (unchanged).
      expect((await get(ctx, await login(ctx, 'colaborador_cliente'), revisionUrl(ctx))).statusCode).toBe(403);
    });
  });
});
