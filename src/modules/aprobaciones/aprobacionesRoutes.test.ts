import Fastify from 'fastify';
import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assignRole,
  createAprobacion,
  createCliente,
  createPieza,
  createPiezaAprobable,
  createPlanSemanal,
  createUsuario,
  moverPieza,
  type PiezaAprobable,
} from '../../../tests/utils/factories/index.js';
import { getTestPool } from '../../../tests/utils/testPool.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { registerAuth } from '../auth/authRoutes.js';
import type { RoleCode } from '../auth/permissions.js';
import { getHuellaPlan } from './aprobacionesRepository.js';
import { registerAprobacionesRoutes } from './aprobacionesRoutes.js';
import { asClienteId } from '../shared/clienteId.js';
import { crearColasRecordatorios, createPgBossRecordatorios, RECORDATORIO_QUEUE } from './recordatoriosJobs.js';
import { FakeRecordatorios, type Recordatorios } from './recordatoriosPort.js';

// One test-transaction client as Db, app.inject(), rollback (the pattern of produccionRoutes.test.ts).
// The reminders go to a fake port, except in the last block, which uses the real pg-boss.

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const INTERNO = 'COMENTARIO-INTERNO-SOLO-NOVACIEL';
const CLIENTE = 'COMENTARIO-DEL-CLIENTE';

interface Ctx {
  app: ReturnType<typeof Fastify>;
  db: Db;
  w: PiezaAprobable;
  recordatorios: FakeRecordatorios;
  logs: string[];
}

async function withApp(fn: (ctx: Ctx) => Promise<void>, recordatorios: Recordatorios | null = null) {
  await withTestTransaction(async (db) => {
    const logs: string[] = [];
    const app = Fastify({ loggerInstance: createLogger('debug', { write: (l: string) => void logs.push(l) }) });
    const fake = new FakeRecordatorios();
    const storage = new FakeStorage();
    const w = await createPiezaAprobable(db, storage);
    await registerAuth(app, { db, allowedOrigin: ORIGIN });
    await registerAprobacionesRoutes(app, { db, storage, recordatorios: recordatorios ?? fake });
    try {
      await fn({ app, db, w, recordatorios: fake, logs });
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

const base = (ctx: Ctx, clienteId = ctx.w.clienteId) => `/clientes/${clienteId}`;
const decisionUrl = (ctx: Ctx, piezaId = ctx.w.piezaId, clienteId = ctx.w.clienteId) => `${base(ctx, clienteId)}/piezas/${piezaId}/decision`;
const internoOk = (ctx: Ctx) => ({ nivel: 'interno', decision: 'aprobada', hash_visto: ctx.w.hashHex });
const clienteOk = (ctx: Ctx) => ({ nivel: 'cliente', decision: 'aprobada', hash_visto: ctx.w.hashHex });
const estadoPieza = async (ctx: Ctx) => (await ctx.db.query('SELECT estado FROM piezas WHERE id = $1', [ctx.w.piezaId])).rows[0]!.estado;
const nRegistros = async (ctx: Ctx) => (await ctx.db.query('SELECT count(*)::int AS n FROM aprobaciones WHERE pieza_id = $1', [ctx.w.piezaId])).rows[0]!.n as number;

/** The piece with the internal approval done through the route, waiting for the client. */
async function esperandoAlCliente(ctx: Ctx) {
  const admin = await login(ctx, 'administrador_novaciel');
  const res = await post(ctx, admin, decisionUrl(ctx), internoOk(ctx));
  expect(res.statusCode, res.body).toBe(200);
  return admin;
}

describe('POST .../piezas/:piezaId/decision', () => {
  it('answers 401 without a session, 400 for a bad body and 404 for an unknown piece, writing nothing', async () => {
    await withApp(async (ctx) => {
      expect((await post(ctx, null, decisionUrl(ctx), internoOk(ctx))).statusCode).toBe(401);
      const admin = await login(ctx, 'administrador_novaciel');
      for (const body of [{}, { ...internoOk(ctx), extra: 1 }, { ...internoOk(ctx), nivel: 'otro' }, { ...internoOk(ctx), hash_visto: 'no-hash' }, { ...internoOk(ctx), decision: 'cambios' }, { ...internoOk(ctx), comentario: ' ' }]) {
        const res = await post(ctx, admin, decisionUrl(ctx), body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error).toBe('invalid_request');
      }
      expect((await post(ctx, admin, decisionUrl(ctx, '123e4567-e89b-42d3-a456-426614174000'), internoOk(ctx))).statusCode).toBe(404);
      expect((await post(ctx, admin, decisionUrl(ctx, 'no-es-un-uuid'), internoOk(ctx))).statusCode).toBe(404);
      expect(await nRegistros(ctx)).toBe(0);
      expect(ctx.recordatorios.programados).toEqual([]);
    });
  });

  it('a wrong hash_visto answers 409 and writes nothing; the right one answers 200', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const stale = await post(ctx, admin, decisionUrl(ctx), { ...internoOk(ctx), hash_visto: 'a'.repeat(64) });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({ error: 'hash_desactualizado' });
      expect(await nRegistros(ctx)).toBe(0);
      expect(await estadoPieza(ctx)).toBe('en_control_calidad');
      expect(ctx.recordatorios.programados).toEqual([]);
      const ok = await post(ctx, admin, decisionUrl(ctx), internoOk(ctx));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ pieza_id: ctx.w.piezaId, pieza_estado: 'esperando_aprobacion', estado_aprobacion: { estado: 'pendiente_cliente' }, rondas_de_cambios: 0, escalada: false });
    });
  });

  it('the internal approval queues the reminders of the piece; a refused or stale decision queues none', async () => {
    await withApp(async (ctx) => {
      const client = await login(ctx, 'aprobador_cliente');
      expect((await post(ctx, client, decisionUrl(ctx), internoOk(ctx))).statusCode).toBe(403);
      expect(ctx.recordatorios.programados).toEqual([]);
      await esperandoAlCliente(ctx);
      expect(ctx.recordatorios.programados).toHaveLength(1);
      expect(ctx.recordatorios.programados[0]!.input).toMatchObject({ clienteId: ctx.w.clienteId, tipo: 'pieza', objetoId: ctx.w.piezaId, referencia: ctx.w.hashHex });
      const approve = await post(ctx, client, decisionUrl(ctx), clienteOk(ctx));
      expect(approve.statusCode).toBe(200);
      expect(approve.json()).toMatchObject({ pieza_estado: 'aprobada', estado_aprobacion: { estado: 'aprobada' } });
      expect(ctx.recordatorios.programados).toHaveLength(1); // the client's decision schedules nothing
    });
  });

  it('403: NovaCiel at the client level (also with a client role), a client at the internal level, another client\'s approver and colaborador_cliente', async () => {
    await withApp(async (ctx) => {
      await esperandoAlCliente(ctx);
      const admin = await login(ctx, 'administrador_novaciel');
      const operator = await login(ctx, 'operador_novaciel');
      await assignRole(ctx.db, { usuarioId: admin.user.id, rolCodigo: 'aprobador_cliente', clienteId: ctx.w.clienteId });
      const otro = await createCliente(ctx.db);
      const foreign = await login(ctx, 'aprobador_cliente', otro.id);
      const colab = await login(ctx, 'colaborador_cliente');
      const owner = await login(ctx, 'dueno_cliente');
      for (const [name, session] of [['admin', admin], ['operator', operator], ['foreign approver', foreign], ['collaborator', colab]] as const) {
        const res = await post(ctx, session, decisionUrl(ctx), clienteOk(ctx));
        expect(res.statusCode, name).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden' });
      }
      expect((await post(ctx, owner, decisionUrl(ctx), internoOk(ctx))).statusCode).toBe(403);
      expect(await estadoPieza(ctx)).toBe('esperando_aprobacion');
      expect(await nRegistros(ctx)).toBe(1); // only the internal approval
    });
  });

  it("409 for a state that cannot be decided, and a piece of another client is not reachable through this client's URL", async () => {
    await withApp(async (ctx) => {
      const client = await login(ctx, 'aprobador_cliente');
      const early = await post(ctx, client, decisionUrl(ctx), clienteOk(ctx));
      expect(early.statusCode).toBe(409);
      expect(early.json()).toEqual({ error: 'estado_invalido', estado: 'en_control_calidad' });
      const otro = await createPiezaAprobable(ctx.db, new FakeStorage());
      const admin = await login(ctx, 'administrador_novaciel');
      // NovaCiel can reach any client, but a piece id of another client under this client's URL is not found.
      expect((await post(ctx, admin, decisionUrl(ctx, otro.piezaId), { ...internoOk(ctx), hash_visto: otro.hashHex })).statusCode).toBe(404);
      // The approver of this client has no rights over the other client's URL.
      expect((await post(ctx, client, decisionUrl(ctx, otro.piezaId, otro.clienteId), { ...clienteOk(ctx), hash_visto: otro.hashHex })).statusCode).toBe(403);
      expect((await ctx.db.query('SELECT count(*)::int AS n FROM aprobaciones WHERE pieza_id = $1', [otro.piezaId])).rows[0]!.n).toBe(0);
    });
  });

  it('a change request needs a reason, moves the piece to con_cambios and counts a round', async () => {
    await withApp(async (ctx) => {
      await esperandoAlCliente(ctx);
      const client = await login(ctx, 'aprobador_cliente');
      expect((await post(ctx, client, decisionUrl(ctx), { nivel: 'cliente', decision: 'cambios', hash_visto: ctx.w.hashHex })).statusCode).toBe(400);
      const res = await post(ctx, client, decisionUrl(ctx), { nivel: 'cliente', decision: 'cambios', hash_visto: ctx.w.hashHex, motivo: 'gancho', segundo_ms: 4200, comentario: CLIENTE });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ pieza_estado: 'con_cambios', estado_aprobacion: { estado: 'cambios_pedidos', ronda: 1 }, rondas_de_cambios: 1 });
    });
  });

  it('stores a coarse device label made from the User-Agent, never the full agent', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const res = await post(ctx, admin, decisionUrl(ctx), { ...internoOk(ctx), dispositivo: IPHONE }, { 'user-agent': IPHONE });
      expect(res.statusCode).toBe(200);
      const { rows } = await ctx.db.query('SELECT dispositivo FROM aprobaciones WHERE pieza_id = $1', [ctx.w.piezaId]);
      expect(rows[0]!.dispositivo).toBe('movil · Safari');
      expect(JSON.stringify(rows)).not.toContain('Mozilla');
    });
  });

  it('does not log the comment, the hash of a stale request or any file name', async () => {
    await withApp(async (ctx) => {
      await esperandoAlCliente(ctx);
      const client = await login(ctx, 'aprobador_cliente');
      await post(ctx, client, decisionUrl(ctx), { nivel: 'cliente', decision: 'cambios', hash_visto: ctx.w.hashHex, motivo: 'texto', comentario: CLIENTE });
      await post(ctx, client, decisionUrl(ctx), { nivel: 'cliente', decision: 'cambios', hash_visto: ctx.w.hashHex, motivo: 'texto', comentario: CLIENTE });
      expect(ctx.logs.join('')).not.toContain(CLIENTE);
    });
  });

  it('keeps the CSRF guard of Step 2b: a POST without Content-Type: application/json is refused', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const res = await ctx.app.inject({ method: 'POST', url: decisionUrl(ctx), headers: admin.headers, payload: JSON.stringify(internoOk(ctx)) });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await nRegistros(ctx)).toBe(0);
    });
  });
});

describe('GET .../aprobaciones/pendientes', () => {
  it('shows each level only what waits for it, with the hash to confirm and no copy', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const client = await login(ctx, 'aprobador_cliente');
      const url = `${base(ctx)}/aprobaciones/pendientes`;
      const interno = (await get(ctx, admin, url)).json();
      expect(interno.nivel).toBe('interno');
      expect(interno.piezas).toHaveLength(1);
      expect(interno.piezas[0]).toMatchObject({ id: ctx.w.piezaId, estado: 'en_control_calidad', version: 1, hash_pieza: ctx.w.hashHex });
      expect(interno.planes).toEqual([]);
      expect((await get(ctx, client, url)).json()).toMatchObject({ nivel: 'cliente', piezas: [], planes: [] });

      await post(ctx, admin, decisionUrl(ctx), internoOk(ctx));
      expect((await get(ctx, admin, url)).json().piezas).toEqual([]);
      const cliente = (await get(ctx, client, url)).json();
      expect(cliente.piezas).toHaveLength(1);
      expect(cliente.piezas[0]).toMatchObject({ id: ctx.w.piezaId, estado: 'esperando_aprobacion', hash_pieza: ctx.w.hashHex });
      expect(JSON.stringify(cliente)).not.toContain('Texto de publicación');
    });
  });

  it('401 without a session; 403 for colaborador_cliente and for another client\'s approver', async () => {
    await withApp(async (ctx) => {
      const url = `${base(ctx)}/aprobaciones/pendientes`;
      expect((await get(ctx, null, url)).statusCode).toBe(401);
      expect((await get(ctx, await login(ctx, 'colaborador_cliente'), url)).statusCode).toBe(403);
      const otro = await createCliente(ctx.db);
      expect((await get(ctx, await login(ctx, 'aprobador_cliente', otro.id), url)).statusCode).toBe(403);
    });
  });
});

describe('GET .../piezas/:piezaId/revision', () => {
  it('returns the current production with signed URLs, its hash and the approval state, without storage keys', async () => {
    await withApp(async (ctx) => {
      await esperandoAlCliente(ctx);
      const client = await login(ctx, 'aprobador_cliente');
      const res = await get(ctx, client, `${base(ctx)}/piezas/${ctx.w.piezaId}/revision`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ id: ctx.w.produccionId, version: 1, hash_pieza: ctx.w.hashHex, hash_version: 'np1', pieza_estado: 'esperando_aprobacion', estado_aprobacion: { estado: 'pendiente_cliente' } });
      expect(body.archivos).toHaveLength(2);
      expect(body.archivos.every((a: { url: string }) => typeof a.url === 'string' && a.url.length > 0)).toBe(true);
      for (const clave of ctx.w.claves) expect(res.body).not.toContain(clave);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  it('comments: NovaCiel reads every comment; the client reads the client-level ones only; the internal level is never shown to the client', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const client = await login(ctx, 'aprobador_cliente');
      const owner = await login(ctx, 'dueno_cliente');
      // An internal approval with a comment, then a client change request with another one (made with the factory so the comments are exact).
      await createAprobacion(ctx.db, { piezaId: ctx.w.piezaId, nivel: 'interno', comentario: INTERNO, usuarioId: admin.user.id });
      await moverPieza(ctx.db, ctx.w.piezaId, 'revision_novaciel');
      await moverPieza(ctx.db, ctx.w.piezaId, 'esperando_aprobacion');
      await createAprobacion(ctx.db, { piezaId: ctx.w.piezaId, nivel: 'cliente', decision: 'cambios', motivo: 'texto', comentario: CLIENTE, usuarioId: client.user.id });
      const url = `${base(ctx)}/piezas/${ctx.w.piezaId}/revision`;

      const comentarios = async (s: Session) => ((await get(ctx, s, url)).json().historial as { nivel: string; comentario: string | null }[]).map((h) => [h.nivel, h.comentario]);
      expect(await comentarios(admin)).toEqual([['interno', INTERNO], ['cliente', CLIENTE]]);
      // The author and another user of the same client read the same thing: the client-level comment, never the internal one.
      expect(await comentarios(client)).toEqual([['interno', null], ['cliente', CLIENTE]]);
      expect(await comentarios(owner)).toEqual([['interno', null], ['cliente', CLIENTE]]);
      const raw = (await get(ctx, owner, url)).body;
      expect(raw).not.toContain(INTERNO);
      // The author is marked, ids of users are never returned.
      const own = (await get(ctx, client, url)).json().historial as { propia: boolean }[];
      expect(own.map((h) => h.propia)).toEqual([false, true]);
      expect(raw).not.toContain(client.user.id);
    });
  });

  it('404 for an unknown piece or a piece without a production; 403 for colaborador_cliente; 401 without a session', async () => {
    await withApp(async (ctx) => {
      const url = (id: string) => `${base(ctx)}/piezas/${id}/revision`;
      expect((await get(ctx, null, url(ctx.w.piezaId))).statusCode).toBe(401);
      expect((await get(ctx, await login(ctx, 'colaborador_cliente'), url(ctx.w.piezaId))).statusCode).toBe(403);
      const client = await login(ctx, 'aprobador_cliente');
      expect((await get(ctx, client, url('123e4567-e89b-42d3-a456-426614174000'))).statusCode).toBe(404);
      const bare = await createPieza(ctx.db, { clienteId: ctx.w.clienteId, planId: ctx.w.planId });
      expect((await get(ctx, client, url(bare.id))).statusCode).toBe(404);
      const otro = await createPiezaAprobable(ctx.db, new FakeStorage());
      expect((await get(ctx, client, url(otro.piezaId))).statusCode).toBe(404);
    });
  });
});

describe('plans: propose, review and decide', () => {
  async function planPropuesto(ctx: Ctx, admin: Session) {
    const plan = await createPlanSemanal(ctx.db, { clienteId: ctx.w.clienteId, semanaInicio: '2027-02-01' });
    for (let i = 0; i < 2; i++) await createPieza(ctx.db, { clienteId: ctx.w.clienteId, planId: plan.id, fechaHora: new Date(Date.now() + (3 + i) * 24 * 3_600_000) });
    const res = await post(ctx, admin, `${base(ctx)}/planes/${plan.id}/proponer`);
    expect(res.statusCode, res.body).toBe(200);
    return plan.id;
  }

  it('NovaCiel proposes (reminders for the plan are queued); the client reads the plan with its fingerprint and approves it', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const client = await login(ctx, 'aprobador_cliente');
      const planId = await planPropuesto(ctx, admin);
      expect(ctx.recordatorios.programados.at(-1)!.input).toMatchObject({ tipo: 'plan', objetoId: planId });
      const pend = (await get(ctx, client, `${base(ctx)}/aprobaciones/pendientes`)).json();
      expect(pend.planes).toHaveLength(1);
      const rev = (await get(ctx, client, `${base(ctx)}/planes/${planId}/revision`)).json();
      expect(rev.huella_plan).toBe(pend.planes[0].huella_plan);
      expect(rev.huella_plan).toBe(await getHuellaPlan(ctx.db, asClienteId(ctx.w.clienteId), planId));
      expect(rev.piezas).toHaveLength(2);

      const stale = await post(ctx, client, `${base(ctx)}/planes/${planId}/decision`, { decision: 'aprobado', huella_vista: 'b'.repeat(64) });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({ error: 'huella_desactualizada' });
      const ok = await post(ctx, client, `${base(ctx)}/planes/${planId}/decision`, { decision: 'aprobado', huella_vista: rev.huella_plan, dispositivo: 'movil · Chrome' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ plan_id: planId, estado: 'aprobado', piezas: 2 });
      const estados = (await ctx.db.query('SELECT estado FROM piezas WHERE plan_id = $1', [planId])).rows.map((r) => r.estado);
      expect(estados).toEqual(['plan_aprobado', 'plan_aprobado']);
    });
  });

  it('refuses: a client proposing, NovaCiel deciding (also with a client role), another client\'s approver, colaborador_cliente', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const client = await login(ctx, 'aprobador_cliente');
      const plan = await createPlanSemanal(ctx.db, { clienteId: ctx.w.clienteId, semanaInicio: '2027-02-01' });
      await createPieza(ctx.db, { clienteId: ctx.w.clienteId, planId: plan.id });
      expect((await post(ctx, client, `${base(ctx)}/planes/${plan.id}/proponer`)).statusCode).toBe(403);
      expect((await post(ctx, admin, `${base(ctx)}/planes/${plan.id}/proponer`)).statusCode).toBe(200);
      expect((await post(ctx, admin, `${base(ctx)}/planes/${plan.id}/proponer`)).statusCode).toBe(409);
      const huella = await getHuellaPlan(ctx.db, asClienteId(ctx.w.clienteId), plan.id);
      const input = { decision: 'aprobado', huella_vista: huella };
      await assignRole(ctx.db, { usuarioId: admin.user.id, rolCodigo: 'aprobador_cliente', clienteId: ctx.w.clienteId });
      const otro = await createCliente(ctx.db);
      for (const [name, s] of [['admin', admin], ['foreign', await login(ctx, 'aprobador_cliente', otro.id)], ['collaborator', await login(ctx, 'colaborador_cliente')]] as const) {
        expect((await post(ctx, s, `${base(ctx)}/planes/${plan.id}/decision`, input)).statusCode, name).toBe(403);
      }
      expect((await get(ctx, null, `${base(ctx)}/planes/${plan.id}/revision`)).statusCode).toBe(401);
      expect((await ctx.db.query('SELECT estado FROM planes_semanales WHERE id = $1', [plan.id])).rows[0]!.estado).toBe('propuesto');
    });
  });

  it('changes requested send the plan back to borrador; the comment is never in the answer or the logs', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const client = await login(ctx, 'aprobador_cliente');
      const planId = await planPropuesto(ctx, admin);
      const huella = await getHuellaPlan(ctx.db, asClienteId(ctx.w.clienteId), planId);
      const res = await post(ctx, client, `${base(ctx)}/planes/${planId}/decision`, { decision: 'cambios', huella_vista: huella, motivo: 'ideas', comentario: CLIENTE });
      expect(res.statusCode).toBe(200);
      expect(res.json().estado).toBe('borrador');
      expect(res.body).not.toContain(CLIENTE);
      expect(ctx.logs.join('')).not.toContain(CLIENTE);
    });
  });
});

// ---- The reminders are REALLY queued: the real pg-boss, in a schema of its own that the tests drop. -------

describe('the routes queue the reminders with the real pg-boss', () => {
  const SCHEMA = 'pgboss_aprobaciones_routes_test';
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: SCHEMA });
  boss.on('error', () => undefined);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await getTestPool().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });

  /** The jobs of the piece, read through the same transaction (they were created in it and are rolled back with it). */
  const trabajos = async (db: Db, piezaId: string) =>
    (await db.query<{ state: string; aviso: string; start_after: Date; data: { objetoId: string; referencia: string } }>(
      `SELECT state, data->>'aviso' AS aviso, start_after, data FROM ${SCHEMA}.job WHERE name = $1 AND data->>'objetoId' = $2 ORDER BY start_after`,
      [RECORDATORIO_QUEUE, piezaId],
    )).rows;

  it('an internal approval through the route leaves the three reminder jobs in the queue; a refused one leaves none', async () => {
    await boss.start();
    await crearColasRecordatorios(boss);
    await withApp(
      async (ctx) => {
        const client = await login(ctx, 'aprobador_cliente');
        expect((await post(ctx, client, decisionUrl(ctx), internoOk(ctx))).statusCode).toBe(403);
        expect((await post(ctx, await login(ctx, 'administrador_novaciel'), decisionUrl(ctx), { ...internoOk(ctx), hash_visto: 'c'.repeat(64) })).statusCode).toBe(409);
        expect(await trabajos(ctx.db, ctx.w.piezaId)).toEqual([]);

        await esperandoAlCliente(ctx);
        const jobs = await trabajos(ctx.db, ctx.w.piezaId);
        expect(jobs.map((j) => j.aviso)).toEqual(['recordatorio_24h', 'recordatorio_4h', 'turno_suplente']);
        expect(jobs.every((j) => j.state === 'created' && j.data.referencia === ctx.w.hashHex)).toBe(true);
        const plazo = (await ctx.db.query<{ fecha_hora: Date }>('SELECT fecha_hora FROM piezas WHERE id = $1', [ctx.w.piezaId])).rows[0]!.fecha_hora;
        expect(jobs.map((j) => plazo.getTime() - j.start_after.getTime())).toEqual([24 * 3_600_000, 4 * 3_600_000, 2 * 3_600_000]);
      },
      createPgBossRecordatorios(boss),
    );
  });
});
