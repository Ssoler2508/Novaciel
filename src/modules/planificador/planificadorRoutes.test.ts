import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { assignRole, createCliente, createPieza, createPlanSemanal, createUsuario } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeAlertSink } from '../../lib/ai/alerts.js';
import { FakeLLMProvider } from '../../lib/ai/fakeLLMProvider.js';
import { createLogger } from '../../lib/logger/index.js';
import { SEED_CLIENT_NAME, SEED_OWNER_EMAIL, seedDevelopment } from '../../scripts/seedDevelopment.js';
import { registerAuth } from '../auth/authRoutes.js';
import type { RoleCode } from '../auth/permissions.js';
import { findClienteByNombreComercial } from '../clientes/clientesRepository.js';
import { getValidHechos } from '../hechos/hechosRepository.js';
import { createNewVersion, getCurrentPerfilMarca } from '../perfilMarca/perfilMarcaRepository.js';
import { getHistorial } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { asClienteId } from '../shared/clienteId.js';
import { getUsuarioByEmail } from '../usuarios/usuariosRepository.js';
import { addDays, localDateOf, mondayOf } from './fechas.js';
import { ejecutarJobGenerarPlan, singletonKeyFor, type GenerarPlanPayload, type JobInfo, type PlanQueue } from './planificadorJobs.js';
import { registerPlanificadorRoutes } from './planificadorRoutes.js';
import { generarPlanSemanal } from './planificadorService.js';

// Same pattern as mediaRoutes.test.ts: one test-transaction client as Db, app.inject(), rollback.
// The queue is a fake (no pg-boss here; planificadorJobs.test.ts uses the real one).

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const ZONE = 'America/New_York';
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];
const nextMonday = (weeks = 1) => addDays(mondayOf(localDateOf(new Date(), ZONE)), 7 * weeks);

class FakeQueue implements PlanQueue {
  readonly enqueued: GenerarPlanPayload[] = [];
  readonly jobs = new Map<string, JobInfo>();
  readonly busy = new Set<string>();
  async enqueue(payload: GenerarPlanPayload): Promise<string | null> {
    const key = singletonKeyFor(payload.clienteId, payload.semana);
    if (this.busy.has(key)) return null;
    this.busy.add(key);
    const id = randomUUID();
    this.enqueued.push(payload);
    this.jobs.set(id, { estado: 'created', clienteId: payload.clienteId, output: null });
    return id;
  }
  async getJob(jobId: string): Promise<JobInfo | null> {
    return this.jobs.get(jobId) ?? null;
  }
}

async function withApp(fn: (ctx: Ctx) => Promise<void>) {
  await withTestTransaction(async (db) => {
    const logs: string[] = [];
    const logger = createLogger('debug', { write: (l: string) => void logs.push(l) });
    const app = Fastify({ loggerInstance: logger });
    const queue = new FakeQueue();
    await registerAuth(app, { db, allowedOrigin: ORIGIN });
    await registerPlanificadorRoutes(app, { db, queue });
    await seedDevelopment(db);
    const clienteId = asClienteId((await findClienteByNombreComercial(db, SEED_CLIENT_NAME))!.id);
    try {
      await fn({ app, db, queue, logs, clienteId });
    } finally {
      await app.close();
    }
  });
}
interface Ctx {
  app: ReturnType<typeof Fastify>;
  db: Db;
  queue: FakeQueue;
  logs: string[];
  clienteId: ReturnType<typeof asClienteId>;
}

async function login(ctx: Ctx, rol: RoleCode, clienteId: string | null = ctx.clienteId) {
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

/** A plan with 3 pieces for the seed client, made by the real service with a scripted fake model. */
async function planWithPieces(ctx: Ctx, semana = nextMonday()) {
  const valid = await getValidHechos(ctx.db, ctx.clienteId);
  const cifra = valid.find((h) => h.tipo === 'cifra')!.id;
  const json = JSON.stringify({
      piezas: [
        { red: 'instagram', formato: 'reel', pilar: 'Origen del café', trabajo: 'atraer', fecha: addDays(semana, 1), hora: '10:00', idea: 'Un vistazo al origen de nuestros granos', hecho_ids: [cifra] },
        { red: 'instagram', formato: 'carrusel', pilar: 'Repostería artesanal', trabajo: 'confianza', fecha: addDays(semana, 3), hora: '12:30', idea: 'Cómo se hornea nuestra torta de zanahoria', hecho_ids: [] },
        { red: 'instagram', formato: 'historia', pilar: 'Vida del barrio', trabajo: 'accion', fecha: addDays(semana, 4), hora: '16:00', idea: 'Pásate hoy por tu café con calma', hecho_ids: [] },
      ],
    });
  const provider = new FakeLLMProvider().enqueue(json);
  const deps = { db: ctx.db, provider, alerts: new FakeAlertSink() };
  return { semana, json, result: await generarPlanSemanal(deps, ctx.clienteId, { semana }, { tipo: 'sistema' }), deps };
}

describe('POST /clientes/:clienteId/planes', () => {
  it('queues a job for NovaCiel staff and answers 202 with the job id and the normalized Monday', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const operator = await login(ctx, 'operador_novaciel');
      const wednesday = addDays(nextMonday(), 2);
      const res = await post(ctx, admin, `/clientes/${ctx.clienteId}/planes`, { semana: wednesday });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ job_id: expect.stringMatching(/^[0-9a-f-]{36}$/), semana_inicio: nextMonday() });
      expect(ctx.queue.enqueued).toEqual([{ clienteId: ctx.clienteId, semana: nextMonday() }]);
      expect(res.headers['cache-control']).toBe('no-store');

      const second = await post(ctx, operator, `/clientes/${ctx.clienteId}/planes`, { semana: nextMonday(2), reemplazar: true });
      expect(second.statusCode).toBe(202);
      expect(ctx.queue.enqueued[1]).toEqual({ clienteId: ctx.clienteId, semana: nextMonday(2), reemplazar: true });
    });
  });

  it('follows the matrix: the client roles and strangers are refused, nothing is queued', async () => {
    await withApp(async (ctx) => {
      const other = asClienteId((await createCliente(ctx.db)).id);
      const sessions = [
        await login(ctx, 'dueno_cliente'),
        await login(ctx, 'aprobador_cliente'),
        await login(ctx, 'colaborador_cliente'),
        await login(ctx, 'dueno_cliente', other), // the owner of ANOTHER client
      ];
      for (const s of sessions) {
        expect((await post(ctx, s, `/clientes/${ctx.clienteId}/planes`, { semana: nextMonday() })).statusCode).toBe(403);
      }
      expect((await post(ctx, null, `/clientes/${ctx.clienteId}/planes`, { semana: nextMonday() })).statusCode).toBe(401);
      expect((await post(ctx, sessions[0]!, `/clientes/not-a-uuid/planes`, { semana: nextMonday() })).statusCode).toBe(403);
      expect(ctx.queue.enqueued).toEqual([]);
    });
  });

  it('an incomplete profile gives 409 with the names of the missing blocks and fields', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const owner = (await getUsuarioByEmail(ctx.db, SEED_OWNER_EMAIL))!;
      const perfil = (await getCurrentPerfilMarca(ctx.db, ctx.clienteId))!;
      const { zona_horaria: _zone, ...operacion } = perfil.operacion as Record<string, unknown>;
      await createNewVersion(ctx.db, ctx.clienteId, { creadoPor: owner.id, operacion });
      const res = await post(ctx, admin, `/clientes/${ctx.clienteId}/planes`, { semana: nextMonday() });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('no_puede_planificar');
      expect(res.json().bloques).toEqual(expect.arrayContaining([{ bloque: 'operacion', faltan: ['zona_horaria'] }]));
      expect(res.body).not.toContain('Aurora');
      expect(ctx.queue.enqueued).toEqual([]);
    });
  });

  it('a week that already has a plan gives 409; a draft can be replaced when asked, a proposed one cannot', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const plan = await createPlanSemanal(ctx.db, { clienteId: ctx.clienteId, semanaInicio: nextMonday(), zonaHoraria: ZONE });
      const url = `/clientes/${ctx.clienteId}/planes`;
      const refused = await post(ctx, admin, url, { semana: addDays(nextMonday(), 3) });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'plan_existente', plan_id: plan.id, estado: 'borrador', reemplazable: true });
      expect((await post(ctx, admin, url, { semana: nextMonday(), reemplazar: true })).statusCode).toBe(202);

      await ctx.db.query(`UPDATE planes_semanales SET estado = 'propuesto' WHERE id = $1`, [plan.id]);
      const proposed = await post(ctx, admin, url, { semana: nextMonday(), reemplazar: true });
      expect(proposed.statusCode).toBe(409);
      expect(proposed.json()).toMatchObject({ error: 'plan_existente', estado: 'propuesto', reemplazable: false });
    });
  });

  it('a generation already queued for the same client and week gives 409', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const url = `/clientes/${ctx.clienteId}/planes`;
      expect((await post(ctx, admin, url, { semana: nextMonday() })).statusCode).toBe(202);
      const again = await post(ctx, admin, url, { semana: addDays(nextMonday(), 4) });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'ya_en_cola', semana_inicio: nextMonday() });
      expect(ctx.queue.enqueued).toHaveLength(1);
    });
  });

  it('validates the body without echoing values', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const url = `/clientes/${ctx.clienteId}/planes`;
      for (const body of [{}, { semana: 'next week' }, { semana: '2026-02-30' }, { semana: nextMonday(), reemplazar: 'yes' }, { semana: nextMonday(), extra: 1 }]) {
        const res = await post(ctx, admin, url, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error).toBe('invalid_request');
        expect(res.body).not.toContain('next week');
      }
      expect(ctx.queue.enqueued).toEqual([]);
    });
  });

  it('the CSRF rules hold: wrong Origin 403, other content types 415', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const url = `/clientes/${ctx.clienteId}/planes`;
      expect((await post(ctx, admin, url, { semana: nextMonday() }, { origin: 'http://evil.example.test' })).statusCode).toBe(403);
      const text = await ctx.app.inject({ method: 'POST', url, headers: { 'content-type': 'text/plain', ...admin.headers }, payload: 'semana' });
      expect(text.statusCode).toBe(415);
      const form = await ctx.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...admin.headers }, payload: 'semana=1' });
      expect(form.statusCode).toBe(415);
      expect((await post(ctx, admin, url, { semana: nextMonday() }, { origin: ORIGIN })).statusCode).toBe(202);
      expect(ctx.queue.enqueued).toHaveLength(1);
    });
  });
});

describe('GET /clientes/:clienteId/planes/trabajos/:jobId', () => {
  const asJob = (clienteId: string, estado: JobInfo['estado'], output: unknown): JobInfo => ({ estado, clienteId, output });

  it('shows the state of a queued job, and the plan id once the job created one', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const queued = await post(ctx, admin, `/clientes/${ctx.clienteId}/planes`, { semana: nextMonday() });
      const jobId = queued.json().job_id as string;
      const url = `/clientes/${ctx.clienteId}/planes/trabajos/${jobId}`;
      expect((await get(ctx, admin, url)).json()).toEqual({ estado: 'created', resultado: null, codigo: null, plan_id: null });

      // The REAL job runs against the fake model; its output is what the queue would keep.
      const { result } = await planWithPieces(ctx, nextMonday(3));
      ctx.queue.jobs.set(jobId, asJob(ctx.clienteId, 'completed', { resultado: 'plan_creado', plan_id: result.plan.id }));
      expect((await get(ctx, admin, url)).json()).toEqual({ estado: 'completed', resultado: 'plan_creado', codigo: null, plan_id: result.plan.id });
    });
  });

  it('end to end through the job worker: success shows the plan id, an expected rejection shows the error name', async () => {
    await withApp(async (ctx) => {
      const operator = await login(ctx, 'operador_novaciel');
      const semana = nextMonday(4);
      const { deps, json } = await planWithPieces(ctx, semana);
      deps.provider.enqueue(json); // the job replaces that draft, so it needs its own model answer
      const first = await ejecutarJobGenerarPlan(deps, { clienteId: ctx.clienteId, semana, reemplazar: true });
      expect(first.resultado).toBe('plan_creado');
      const okJob = randomUUID();
      ctx.queue.jobs.set(okJob, asJob(ctx.clienteId, 'completed', first));
      const ok = await get(ctx, operator, `/clientes/${ctx.clienteId}/planes/trabajos/${okJob}`);
      expect(ok.json()).toMatchObject({ estado: 'completed', resultado: 'plan_creado', plan_id: first.plan_id, codigo: null });

      // Now the week has a plan, so the same job is rejected without spending anything.
      const second = await ejecutarJobGenerarPlan(deps, { clienteId: ctx.clienteId, semana });
      expect(second).toEqual({ resultado: 'rechazado', codigo: 'PlanExistenteError' });
      const rejectedJob = randomUUID();
      ctx.queue.jobs.set(rejectedJob, asJob(ctx.clienteId, 'completed', second));
      const rejected = await get(ctx, operator, `/clientes/${ctx.clienteId}/planes/trabajos/${rejectedJob}`);
      expect(rejected.json()).toEqual({ estado: 'completed', resultado: 'rechazado', codigo: 'PlanExistenteError', plan_id: null });
    });
  });

  it("another client's job gives 404, as do unknown and malformed ids", async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const other = (await createCliente(ctx.db)).id;
      const foreignJob = randomUUID();
      ctx.queue.jobs.set(foreignJob, asJob(other, 'completed', { resultado: 'plan_creado', plan_id: randomUUID() }));
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/planes/trabajos/${foreignJob}`)).statusCode).toBe(404);
      // The same job under its own client is visible (NovaCiel staff reach every client).
      expect((await get(ctx, admin, `/clientes/${other}/planes/trabajos/${foreignJob}`)).statusCode).toBe(200);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/planes/trabajos/${randomUUID()}`)).statusCode).toBe(404);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/planes/trabajos/not-a-uuid`)).statusCode).toBe(404);
      // A job without a readable client in its payload is nobody's.
      const orphan = randomUUID();
      ctx.queue.jobs.set(orphan, { estado: 'completed', clienteId: null, output: {} });
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/planes/trabajos/${orphan}`)).statusCode).toBe(404);
    });
  });

  it('is for NovaCiel staff only, and shows nothing but the whitelisted, content-free fields', async () => {
    await withApp(async (ctx) => {
      const jobId = randomUUID();
      ctx.queue.jobs.set(jobId, asJob(ctx.clienteId, 'failed', { message: 'SECRETO-DEL-ERROR', stack: 'at secret', resultado: 'hackeado', plan_id: 'no-uuid' }));
      const url = `/clientes/${ctx.clienteId}/planes/trabajos/${jobId}`;
      for (const rol of ['dueno_cliente', 'aprobador_cliente', 'colaborador_cliente'] as RoleCode[]) {
        expect((await get(ctx, await login(ctx, rol), url)).statusCode, rol).toBe(403);
      }
      expect((await get(ctx, null, url)).statusCode).toBe(401);
      const res = await get(ctx, await login(ctx, 'operador_novaciel'), url);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ estado: 'failed', resultado: null, codigo: null, plan_id: null });
      expect(res.body).not.toMatch(/SECRETO|secret|hackeado/);
    });
  });
});

describe('GET plans', () => {
  it('lists the active plans of a week and shows the plan with its pieces', async () => {
    await withApp(async (ctx) => {
      const { result, semana } = await planWithPieces(ctx);
      const roles: [RoleCode, number][] = [['administrador_novaciel', 200], ['operador_novaciel', 200], ['dueno_cliente', 200], ['aprobador_cliente', 200], ['colaborador_cliente', 403]];
      for (const [rol, status] of roles) {
        const s = await login(ctx, rol);
        expect((await get(ctx, s, `/clientes/${ctx.clienteId}/planes`)).statusCode, rol).toBe(status);
        expect((await get(ctx, s, `/clientes/${ctx.clienteId}/planes/${result.plan.id}`)).statusCode, rol).toBe(status);
      }

      const owner = await login(ctx, 'dueno_cliente');
      const list = (await get(ctx, owner, `/clientes/${ctx.clienteId}/planes?semana=${addDays(semana, 2)}`)).json();
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ id: result.plan.id, semana_inicio: semana, estado: 'borrador', zona_horaria: ZONE, piezas: 3 });
      expect((await get(ctx, owner, `/clientes/${ctx.clienteId}/planes?semana=${addDays(semana, 7)}`)).json().items).toEqual([]);
      expect((await get(ctx, owner, `/clientes/${ctx.clienteId}/planes?semana=nope`)).statusCode).toBe(400);

      const detail = (await get(ctx, owner, `/clientes/${ctx.clienteId}/planes/${result.plan.id}`)).json();
      expect(detail).toMatchObject({ id: result.plan.id, estado: 'borrador', semana_inicio: semana });
      expect(detail.piezas).toHaveLength(3);
      expect(detail.piezas[0]).toMatchObject({
        red: 'instagram', formato: 'reel', pilar: 'Origen del café', trabajo: 'atraer', idea: 'Un vistazo al origen de nuestros granos',
        estado: 'planeada', estado_previo: null, fecha_hora_local: { fecha: addDays(semana, 1), hora: '10:00', zona_horaria: ZONE },
      });
      expect(new Date(detail.piezas[0].fecha_hora_utc).getTime()).toBe(result.piezas[0]!.fecha_hora.getTime());
      expect(detail.piezas[0].hecho_ids).toHaveLength(1);
      expect(JSON.stringify(detail)).not.toMatch(/prompt|system|EXTERNAL_DATA/);
    });
  });

  it('hides discarded plans from the list but still shows them by id, with their dead pieces', async () => {
    await withApp(async (ctx) => {
      const owner = await login(ctx, 'dueno_cliente');
      const { result } = await planWithPieces(ctx);
      await ctx.db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [result.plan.id]);
      expect((await get(ctx, owner, `/clientes/${ctx.clienteId}/planes`)).json().items).toEqual([]);
      const detail = (await get(ctx, owner, `/clientes/${ctx.clienteId}/planes/${result.plan.id}`)).json();
      expect(detail.estado).toBe('descartado');
      expect(detail.piezas).toHaveLength(3);
    });
  });

  it("another client's plan is 404 under your own id and 403 under theirs; bad ids are 404", async () => {
    await withApp(async (ctx) => {
      const other = asClienteId((await createCliente(ctx.db)).id);
      const foreign = await createPlanSemanal(ctx.db, { clienteId: other, semanaInicio: nextMonday() });
      const owner = await login(ctx, 'dueno_cliente');
      expect((await get(ctx, owner, `/clientes/${ctx.clienteId}/planes/${foreign.id}`)).statusCode).toBe(404);
      expect((await get(ctx, owner, `/clientes/${other}/planes/${foreign.id}`)).statusCode).toBe(403);
      expect((await get(ctx, owner, `/clientes/${other}/planes`)).statusCode).toBe(403);
      expect((await get(ctx, owner, `/clientes/${ctx.clienteId}/planes/not-a-uuid`)).statusCode).toBe(404);
      expect((await get(ctx, owner, `/clientes/${ctx.clienteId}/planes`)).json().items).toEqual([]);
    });
  });
});

describe('POST pausar / reanudar', () => {
  async function onePiece(ctx: Ctx) {
    const { result } = await planWithPieces(ctx);
    return result.piezas[0]!;
  }
  const url = (ctx: Ctx, piezaId: string, accion: 'pausar' | 'reanudar') => `/clientes/${ctx.clienteId}/piezas/${piezaId}/${accion}`;

  it('NovaCiel staff can pause and resume; the history keeps the user and the reason', async () => {
    await withApp(async (ctx) => {
      const pieza = await onePiece(ctx);
      const admin = await login(ctx, 'administrador_novaciel');
      const paused = await post(ctx, admin, url(ctx, pieza.id, 'pausar'), { motivo: 'Interruptor general' });
      expect(paused.statusCode).toBe(200);
      expect(paused.json()).toMatchObject({ id: pieza.id, estado: 'pausada', estado_previo: 'planeada' });
      const resumed = await post(ctx, await login(ctx, 'operador_novaciel'), url(ctx, pieza.id, 'reanudar'));
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({ estado: 'planeada', estado_previo: null });
      const history = await getHistorial(ctx.db, ctx.clienteId, pieza.id);
      expect(history.map((h) => [h.desde, h.hacia])).toEqual([[null, 'planeada'], ['planeada', 'pausada'], ['pausada', 'planeada']]);
      expect(history[1]).toMatchObject({ actor_tipo: 'usuario', actor_usuario_id: admin.user.id, motivo: 'Interruptor general' });
      expect((await auditRowsFor(ctx.db, 'piezas', pieza.id)).filter((a) => a.accion === 'cambiar_estado')).toHaveLength(2);
    });
  });

  it('the client roles, strangers and anonymous callers are refused', async () => {
    await withApp(async (ctx) => {
      const pieza = await onePiece(ctx);
      const other = asClienteId((await createCliente(ctx.db)).id);
      const sessions = [await login(ctx, 'dueno_cliente'), await login(ctx, 'aprobador_cliente'), await login(ctx, 'colaborador_cliente'), await login(ctx, 'dueno_cliente', other)];
      for (const s of sessions) {
        expect((await post(ctx, s, url(ctx, pieza.id, 'pausar'))).statusCode).toBe(403);
        expect((await post(ctx, s, url(ctx, pieza.id, 'reanudar'))).statusCode).toBe(403);
      }
      expect((await post(ctx, null, url(ctx, pieza.id, 'pausar'))).statusCode).toBe(401);
      const state = await ctx.db.query('SELECT estado FROM piezas WHERE id = $1', [pieza.id]);
      expect(state.rows[0].estado).toBe('planeada');
    });
  });

  it('answers 409 for a terminal piece, for resuming a piece that is not paused, and for a discarded plan', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const pieza = await onePiece(ctx);
      expect((await post(ctx, admin, url(ctx, pieza.id, 'reanudar'))).json()).toEqual({ error: 'no_pausada', estado: 'planeada' });

      // A terminal piece (cerrada) cannot be paused.
      const plan = await createPlanSemanal(ctx.db, { clienteId: ctx.clienteId, semanaInicio: nextMonday(6) });
      const closed = await createPieza(ctx.db, { clienteId: ctx.clienteId, planId: plan.id, estado: 'cerrada' });
      const terminal = await post(ctx, admin, url(ctx, closed.id, 'pausar'));
      expect(terminal.statusCode).toBe(409);
      expect(terminal.json()).toEqual({ error: 'transicion_invalida', desde: 'cerrada', hacia: 'pausada' });

      // Pausing twice.
      await post(ctx, admin, url(ctx, pieza.id, 'pausar'));
      expect((await post(ctx, admin, url(ctx, pieza.id, 'pausar'))).json()).toMatchObject({ error: 'transicion_invalida' });

      // The piece of a discarded plan.
      await ctx.db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [pieza.plan_id]);
      const dead = await post(ctx, admin, url(ctx, pieza.id, 'reanudar'));
      expect(dead.statusCode).toBe(409);
      expect(dead.json()).toEqual({ error: 'plan_descartado' });
    });
  });

  it("another client's piece is 404 under your id; unknown and malformed ids are 404; a bad reason is 400", async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const other = asClienteId((await createCliente(ctx.db)).id);
      const foreign = await createPieza(ctx.db, { clienteId: other });
      expect((await post(ctx, admin, url(ctx, foreign.id, 'pausar'))).statusCode).toBe(404);
      expect((await post(ctx, admin, url(ctx, randomUUID(), 'pausar'))).statusCode).toBe(404);
      expect((await post(ctx, admin, url(ctx, 'not-a-uuid', 'pausar'))).statusCode).toBe(404);
      expect((await ctx.db.query('SELECT estado FROM piezas WHERE id = $1', [foreign.id])).rows[0].estado).toBe('planeada');

      const pieza = await onePiece(ctx);
      for (const body of [{ motivo: '   ' }, { motivo: 'x'.repeat(501) }, { otra: 1 }, { motivo: 5 }]) {
        expect((await post(ctx, admin, url(ctx, pieza.id, 'pausar'), body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      expect((await ctx.db.query('SELECT estado FROM piezas WHERE id = $1', [pieza.id])).rows[0].estado).toBe('planeada');
    });
  });

  it('a piece can still be moved by the service afterwards (the routes add no other transitions)', async () => {
    await withApp(async (ctx) => {
      const pieza = await onePiece(ctx);
      await post(ctx, await login(ctx, 'administrador_novaciel'), url(ctx, pieza.id, 'pausar'));
      await post(ctx, await login(ctx, 'administrador_novaciel'), url(ctx, pieza.id, 'reanudar'));
      expect((await transitionPieza(ctx.db, ctx.clienteId, pieza.id, 'plan_aprobado', { tipo: 'sistema' })).estado).toBe('plan_aprobado');
      for (const accion of ['aprobar', 'cancelar', 'estado']) {
        expect((await post(ctx, await login(ctx, 'administrador_novaciel'), url(ctx, pieza.id, accion as 'pausar'))).statusCode).toBe(404);
      }
    });
  });
});
