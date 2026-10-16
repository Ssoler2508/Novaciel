import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { assignRole, createCliente, createGuion, createPieza, createPlanSemanal, createUsuario, moverPieza } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { SEED_CLIENT_NAME, seedDevelopment } from '../../scripts/seedDevelopment.js';
import { registerAuth } from '../auth/authRoutes.js';
import type { RoleCode } from '../auth/permissions.js';
import { findClienteByNombreComercial } from '../clientes/clientesRepository.js';
import { getCurrentPerfilMarca } from '../perfilMarca/perfilMarcaRepository.js';
import { pausarPieza } from '../piezas/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { factToken } from './tokens.js';
import {
  singletonKeyPieza,
  singletonKeyPlan,
  type BriefJobInfo,
  type BriefPiezaPayload,
  type BriefQueue,
  type BriefsPlanPayload,
} from './directorJobs.js';
import { registerDirectorRoutes } from './directorRoutes.js';

// Same pattern as planificadorRoutes.test.ts: one test-transaction client as Db, app.inject(),
// rollback. The queue is a fake (the real pg-boss is in directorJobs.test.ts).

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];

class FakeQueue implements BriefQueue {
  readonly planJobs: BriefsPlanPayload[] = [];
  readonly piezaJobs: BriefPiezaPayload[] = [];
  readonly jobs = new Map<string, BriefJobInfo>();
  readonly busy = new Set<string>();
  readonly activePlan = new Map<string, string>();
  async enqueuePlan(payload: BriefsPlanPayload): Promise<string | null> {
    const key = `plan:${singletonKeyPlan(payload.clienteId, payload.planId)}`;
    if (this.busy.has(key)) return null;
    this.busy.add(key);
    const id = randomUUID();
    this.planJobs.push(payload);
    this.jobs.set(id, { tipo: 'plan', estado: 'created', clienteId: payload.clienteId, output: null });
    this.activePlan.set(singletonKeyPlan(payload.clienteId, payload.planId), id);
    return id;
  }
  async enqueuePieza(payload: BriefPiezaPayload): Promise<string | null> {
    const key = `pieza:${singletonKeyPieza(payload.clienteId, payload.piezaId)}`;
    if (this.busy.has(key)) return null;
    this.busy.add(key);
    const id = randomUUID();
    this.piezaJobs.push(payload);
    this.jobs.set(id, { tipo: 'pieza', estado: 'created', clienteId: payload.clienteId, output: null });
    return id;
  }
  async findActivePlanJob(clienteId: string, planId: string): Promise<string | null> {
    return this.activePlan.get(singletonKeyPlan(clienteId, planId)) ?? null;
  }
  async getJob(jobId: string): Promise<BriefJobInfo | null> {
    return this.jobs.get(jobId) ?? null;
  }
  get queued() {
    return this.planJobs.length + this.piezaJobs.length;
  }
}

interface Ctx {
  app: ReturnType<typeof Fastify>;
  db: Db;
  queue: FakeQueue;
  logs: string[];
  clienteId: ReturnType<typeof asClienteId>;
  perfilId: string;
}

async function withApp(fn: (ctx: Ctx) => Promise<void>) {
  await withTestTransaction(async (db) => {
    const logs: string[] = [];
    const logger = createLogger('debug', { write: (l: string) => void logs.push(l) });
    const app = Fastify({ loggerInstance: logger });
    const queue = new FakeQueue();
    await registerAuth(app, { db, allowedOrigin: ORIGIN });
    await registerDirectorRoutes(app, { db, queue });
    await seedDevelopment(db);
    const clienteId = asClienteId((await findClienteByNombreComercial(db, SEED_CLIENT_NAME))!.id);
    const perfilId = (await getCurrentPerfilMarca(db, clienteId))!.id;
    try {
      await fn({ app, db, queue, logs, clienteId, perfilId });
    } finally {
      await app.close();
    }
  });
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

let weekCounter = 0;
/** A Monday that no other plan of the same test has used yet. */
const freshMonday = () => new Date(Date.UTC(2027, 0, 4 + 7 * weekCounter++)).toISOString().slice(0, 10);

/** An APPROVED plan of the seed client with `n` pieces waiting for their brief (a week of its own by default). */
async function approvedPlan(ctx: Ctx, n = 2, semana = freshMonday()) {
  const plan = await createPlanSemanal(ctx.db, { clienteId: ctx.clienteId, perfilMarcaId: ctx.perfilId, estado: 'aprobado', semanaInicio: semana });
  const piezas = [];
  for (let i = 0; i < n; i++) piezas.push(await createPieza(ctx.db, { clienteId: ctx.clienteId, planId: plan.id, estado: 'plan_aprobado', formato: 'carrusel' }));
  return { plan, piezas };
}

/** A piece that already has a brief (version 1, rendered content without tokens). */
async function pieceWithBrief(ctx: Ctx, contenido?: Record<string, unknown>) {
  const { plan, piezas } = await approvedPlan(ctx, 1);
  const guion = await createGuion(ctx.db, { piezaId: piezas[0]!.id, ...(contenido ? { contenido, contenidoModelo: { ...contenido, gancho: `Hoy ${factToken(randomUUID())}` } } : {}) });
  await moverPieza(ctx.db, piezas[0]!.id, 'guion_listo');
  return { plan, pieza: piezas[0]!, guion };
}

describe('POST /clientes/:clienteId/planes/:planId/briefs', () => {
  it('queues a plan job for NovaCiel staff and answers 202 with the job id', async () => {
    await withApp(async (ctx) => {
      const { plan } = await approvedPlan(ctx);
      const admin = await login(ctx, 'administrador_novaciel');
      const res = await post(ctx, admin, `/clientes/${ctx.clienteId}/planes/${plan.id}/briefs`, {});
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ job_id: expect.stringMatching(/^[0-9a-f-]{36}$/), plan_id: plan.id });
      expect(ctx.queue.planJobs).toEqual([{ clienteId: ctx.clienteId, planId: plan.id }]);
      expect(res.headers['cache-control']).toBe('no-store');

      const operator = await login(ctx, 'operador_novaciel');
      const other = await approvedPlan(ctx, 1, '2026-11-16');
      expect((await post(ctx, operator, `/clientes/${ctx.clienteId}/planes/${other.plan.id}/briefs`, {})).statusCode).toBe(202);
    });
  });

  it('follows the matrix: the client roles, strangers and anonymous callers are refused, nothing is queued', async () => {
    await withApp(async (ctx) => {
      const { plan } = await approvedPlan(ctx);
      const other = asClienteId((await createCliente(ctx.db)).id);
      const url = `/clientes/${ctx.clienteId}/planes/${plan.id}/briefs`;
      for (const s of [
        await login(ctx, 'dueno_cliente'),
        await login(ctx, 'aprobador_cliente'),
        await login(ctx, 'colaborador_cliente'),
        await login(ctx, 'dueno_cliente', other), // the owner of ANOTHER client
      ]) {
        expect((await post(ctx, s, url, {})).statusCode).toBe(403);
      }
      expect((await post(ctx, null, url, {})).statusCode).toBe(401);
      expect(ctx.queue.queued).toBe(0);
    });
  });

  it("another client's plan gives 403 under their id and 404 under yours; unknown and malformed ids give 404", async () => {
    await withApp(async (ctx) => {
      const other = asClienteId((await createCliente(ctx.db)).id);
      const foreign = await createPlanSemanal(ctx.db, { clienteId: other, estado: 'aprobado', semanaInicio: '2026-11-09' });
      const admin = await login(ctx, 'administrador_novaciel');
      expect((await post(ctx, admin, `/clientes/${ctx.clienteId}/planes/${foreign.id}/briefs`, {})).statusCode).toBe(404);
      expect((await post(ctx, admin, `/clientes/${ctx.clienteId}/planes/${randomUUID()}/briefs`, {})).statusCode).toBe(404);
      expect((await post(ctx, admin, `/clientes/${ctx.clienteId}/planes/not-a-uuid/briefs`, {})).statusCode).toBe(404);
      const owner = await login(ctx, 'dueno_cliente');
      expect((await post(ctx, owner, `/clientes/${other}/planes/${foreign.id}/briefs`, {})).statusCode).toBe(403);
      expect(ctx.queue.queued).toBe(0);
    });
  });

  it('refuses with 409 a plan that is not approved, is discarded, has no eligible piece, or is already queued', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const url = (planId: string) => `/clientes/${ctx.clienteId}/planes/${planId}/briefs`;

      const draft = await createPlanSemanal(ctx.db, { clienteId: ctx.clienteId, perfilMarcaId: ctx.perfilId, semanaInicio: '2026-11-16' });
      const noAprobado = await post(ctx, admin, url(draft.id), {});
      expect(noAprobado.statusCode).toBe(409);
      expect(noAprobado.json()).toEqual({ error: 'plan_no_aprobado', estado: 'borrador' });

      const discarded = await createPlanSemanal(ctx.db, { clienteId: ctx.clienteId, perfilMarcaId: ctx.perfilId, estado: 'descartado', semanaInicio: '2026-11-23' });
      expect((await post(ctx, admin, url(discarded.id), {})).json()).toEqual({ error: 'plan_descartado' });

      const empty = await approvedPlan(ctx, 0, '2026-11-30');
      expect((await post(ctx, admin, url(empty.plan.id), {})).json()).toEqual({ error: 'sin_piezas_elegibles' });
      // Pieces that already have their brief or are paused are not eligible either.
      const withBrief = await pieceWithBrief(ctx);
      expect((await post(ctx, admin, url(withBrief.plan.id), {})).json()).toEqual({ error: 'sin_piezas_elegibles' });

      const { plan } = await approvedPlan(ctx, 1, '2026-12-07');
      expect((await post(ctx, admin, url(plan.id), {})).statusCode).toBe(202);
      const again = await post(ctx, admin, url(plan.id), {});
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'ya_en_cola' });
      expect(ctx.queue.planJobs).toHaveLength(1);
    });
  });

  it('validates the body without echoing values', async () => {
    await withApp(async (ctx) => {
      const { plan } = await approvedPlan(ctx);
      const admin = await login(ctx, 'administrador_novaciel');
      const url = `/clientes/${ctx.clienteId}/planes/${plan.id}/briefs`;
      for (const body of [{ regenerar: true }, { extra: 'SECRETO-DE-PRUEBA' }]) {
        const res = await post(ctx, admin, url, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error).toBe('invalid_request');
        expect(res.body).not.toContain('SECRETO');
      }
      expect(ctx.queue.queued).toBe(0);
    });
  });

  it('the CSRF rules hold: wrong Origin 403, other content types 415', async () => {
    await withApp(async (ctx) => {
      const { plan } = await approvedPlan(ctx);
      const admin = await login(ctx, 'administrador_novaciel');
      const url = `/clientes/${ctx.clienteId}/planes/${plan.id}/briefs`;
      expect((await post(ctx, admin, url, {}, { origin: 'http://evil.example.test' })).statusCode).toBe(403);
      const text = await ctx.app.inject({ method: 'POST', url, headers: { 'content-type': 'text/plain', ...admin.headers }, payload: 'x' });
      expect(text.statusCode).toBe(415);
      const form = await ctx.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...admin.headers }, payload: 'a=1' });
      expect(form.statusCode).toBe(415);
      expect((await post(ctx, admin, url, {}, { origin: ORIGIN })).statusCode).toBe(202);
      expect(ctx.queue.planJobs).toHaveLength(1);
    });
  });
});

describe('POST /clientes/:clienteId/piezas/:piezaId/brief', () => {
  it('queues a piece job (asynchronous) for NovaCiel staff and answers 202', async () => {
    await withApp(async (ctx) => {
      const { piezas } = await approvedPlan(ctx, 1);
      const admin = await login(ctx, 'administrador_novaciel');
      const res = await post(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${piezas[0]!.id}/brief`, {});
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ job_id: expect.stringMatching(/^[0-9a-f-]{36}$/), pieza_id: piezas[0]!.id });
      expect(ctx.queue.piezaJobs).toEqual([{ clienteId: ctx.clienteId, piezaId: piezas[0]!.id }]);
    });
  });

  it('regenerar: true is queued for a piece that has a brief and has not left guion_listo', async () => {
    await withApp(async (ctx) => {
      const { pieza } = await pieceWithBrief(ctx);
      const admin = await login(ctx, 'operador_novaciel');
      const url = `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief`;
      const refused = await post(ctx, admin, url, {});
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'brief_existente', version: 1 });
      expect((await post(ctx, admin, url, { regenerar: true })).statusCode).toBe(202);
      expect(ctx.queue.piezaJobs).toEqual([{ clienteId: ctx.clienteId, piezaId: pieza.id, regenerar: true }]);
    });
  });

  it('follows the matrix and keeps clients apart', async () => {
    await withApp(async (ctx) => {
      const { piezas } = await approvedPlan(ctx, 1);
      const other = asClienteId((await createCliente(ctx.db)).id);
      const otherPlan = await createPlanSemanal(ctx.db, { clienteId: other, estado: 'aprobado', semanaInicio: '2026-11-09' });
      const foreign = await createPieza(ctx.db, { clienteId: other, planId: otherPlan.id, estado: 'plan_aprobado' });
      const url = `/clientes/${ctx.clienteId}/piezas/${piezas[0]!.id}/brief`;
      for (const s of [await login(ctx, 'dueno_cliente'), await login(ctx, 'aprobador_cliente'), await login(ctx, 'colaborador_cliente'), await login(ctx, 'dueno_cliente', other)]) {
        expect((await post(ctx, s, url, {})).statusCode).toBe(403);
      }
      expect((await post(ctx, null, url, {})).statusCode).toBe(401);

      const admin = await login(ctx, 'administrador_novaciel');
      // Another client's piece under your own client id is 404, and it is never queued.
      expect((await post(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${foreign.id}/brief`, {})).statusCode).toBe(404);
      expect((await post(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${randomUUID()}/brief`, {})).statusCode).toBe(404);
      expect((await post(ctx, admin, `/clientes/${ctx.clienteId}/piezas/not-a-uuid/brief`, {})).statusCode).toBe(404);
      expect(ctx.queue.queued).toBe(0);
    });
  });

  it('refuses with 409 a piece in the wrong state, a paused one, and a plan that is not approved or is discarded', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const url = (piezaId: string) => `/clientes/${ctx.clienteId}/piezas/${piezaId}/brief`;
      const { plan, piezas } = await approvedPlan(ctx, 2);

      const enProduccion = await createPieza(ctx.db, { clienteId: ctx.clienteId, planId: plan.id, estado: 'en_produccion' });
      expect((await post(ctx, admin, url(enProduccion.id), {})).json()).toEqual({ error: 'estado_invalido', estado: 'en_produccion' });
      await pausarPieza(ctx.db, ctx.clienteId, piezas[0]!.id, { tipo: 'sistema' });
      expect((await post(ctx, admin, url(piezas[0]!.id), {})).json()).toEqual({ error: 'estado_invalido', estado: 'pausada' });

      const draft = await createPlanSemanal(ctx.db, { clienteId: ctx.clienteId, perfilMarcaId: ctx.perfilId, semanaInicio: '2026-11-16' });
      const inDraft = await createPieza(ctx.db, { clienteId: ctx.clienteId, planId: draft.id });
      expect((await post(ctx, admin, url(inDraft.id), {})).json()).toEqual({ error: 'plan_no_aprobado', estado: 'borrador' });

      await ctx.db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [plan.id]);
      expect((await post(ctx, admin, url(piezas[1]!.id), {})).json()).toEqual({ error: 'plan_descartado' });
      expect(ctx.queue.queued).toBe(0);
    });
  });

  it('returns 409 plan_en_proceso, enqueuing nothing, while a plan run for the piece\'s plan is queued or active', async () => {
    await withApp(async (ctx) => {
      const { plan, piezas } = await approvedPlan(ctx, 2);
      const admin = await login(ctx, 'administrador_novaciel');
      const planRun = await post(ctx, admin, `/clientes/${ctx.clienteId}/planes/${plan.id}/briefs`, {});
      expect(planRun.statusCode).toBe(202);

      for (const pieza of piezas) {
        const res = await post(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief`, {});
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: 'plan_en_proceso', job_id: planRun.json().job_id });
      }
      expect(ctx.queue.piezaJobs).toEqual([]);

      // A piece of ANOTHER plan is not affected.
      const other = await approvedPlan(ctx, 1, '2026-11-16');
      expect((await post(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${other.piezas[0]!.id}/brief`, {})).statusCode).toBe(202);
    });
  });

  it('a piece job already queued for the same piece gives 409 ya_en_cola', async () => {
    await withApp(async (ctx) => {
      const { piezas } = await approvedPlan(ctx, 1);
      const admin = await login(ctx, 'administrador_novaciel');
      const url = `/clientes/${ctx.clienteId}/piezas/${piezas[0]!.id}/brief`;
      expect((await post(ctx, admin, url, {})).statusCode).toBe(202);
      const again = await post(ctx, admin, url, {});
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'ya_en_cola' });
      expect(ctx.queue.piezaJobs).toHaveLength(1);
    });
  });

  it('validates the body without echoing values, and holds the CSRF rules', async () => {
    await withApp(async (ctx) => {
      const { piezas } = await approvedPlan(ctx, 1);
      const admin = await login(ctx, 'administrador_novaciel');
      const url = `/clientes/${ctx.clienteId}/piezas/${piezas[0]!.id}/brief`;
      for (const body of [{ regenerar: 'SECRETO-DE-PRUEBA' }, { regenerar: 1 }, { extra: true }]) {
        const res = await post(ctx, admin, url, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.body).not.toContain('SECRETO');
      }
      expect((await post(ctx, admin, url, {}, { origin: 'http://evil.example.test' })).statusCode).toBe(403);
      const text = await ctx.app.inject({ method: 'POST', url, headers: { 'content-type': 'text/plain', ...admin.headers }, payload: 'x' });
      expect(text.statusCode).toBe(415);
      expect(ctx.queue.queued).toBe(0);
      expect((await post(ctx, admin, url, {}, { origin: ORIGIN })).statusCode).toBe(202);
    });
  });
});

describe('GET /clientes/:clienteId/briefs/trabajos/:jobId', () => {
  const addJob = (ctx: Ctx, clienteId: string, info: Partial<BriefJobInfo>) => {
    const id = randomUUID();
    ctx.queue.jobs.set(id, { tipo: 'plan', estado: 'completed', clienteId, output: null, ...info });
    return id;
  };

  it('shows the state of a queued job and the counts of a finished plan run', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const queued = addJob(ctx, ctx.clienteId, { estado: 'created' });
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/briefs/trabajos/${queued}`)).json()).toEqual({
        tipo: 'plan', estado: 'created', resultado: null, codigo: null, resumen: null, piezas: null, guion_id: null, version: null,
      });
      const piezaId = randomUUID();
      const done = addJob(ctx, ctx.clienteId, {
        output: {
          resultado: 'briefs_generados',
          resumen: { ok: 1, omitidas: 1, fallidas: 1, detenido_por_presupuesto: false },
          piezas: [
            { pieza_id: piezaId, resultado: 'ok', version: 1 },
            { pieza_id: randomUUID(), resultado: 'omitida', motivo: 'ya_tiene_guion' },
            { pieza_id: randomUUID(), resultado: 'fallida', codigo: 'SchemaValidationError' },
          ],
        },
      });
      const res = await get(ctx, admin, `/clientes/${ctx.clienteId}/briefs/trabajos/${done}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ tipo: 'plan', estado: 'completed', resultado: 'briefs_generados', resumen: { ok: 1, omitidas: 1, fallidas: 1, detenido_por_presupuesto: false } });
      expect(res.json().piezas).toHaveLength(3);
      expect(res.json().piezas[0]).toEqual({ pieza_id: piezaId, resultado: 'ok', version: 1 });
    });
  });

  it('shows the guion id and version of a piece job, and the error name of a rejection', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'operador_novaciel');
      const guionId = randomUUID();
      const ok = addJob(ctx, ctx.clienteId, { tipo: 'pieza', output: { resultado: 'brief_creado', guion_id: guionId, version: 2 } });
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/briefs/trabajos/${ok}`)).json()).toMatchObject({ tipo: 'pieza', resultado: 'brief_creado', guion_id: guionId, version: 2 });
      const rejected = addJob(ctx, ctx.clienteId, { tipo: 'pieza', output: { resultado: 'rechazado', codigo: 'BriefExistenteError' } });
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/briefs/trabajos/${rejected}`)).json()).toMatchObject({ resultado: 'rechazado', codigo: 'BriefExistenteError' });
    });
  });

  it("another client's job, an unknown job and a malformed id all give 404", async () => {
    await withApp(async (ctx) => {
      const other = asClienteId((await createCliente(ctx.db)).id);
      const admin = await login(ctx, 'administrador_novaciel');
      const foreign = addJob(ctx, other, {});
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/briefs/trabajos/${foreign}`)).statusCode).toBe(404);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/briefs/trabajos/${randomUUID()}`)).statusCode).toBe(404);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/briefs/trabajos/not-a-uuid`)).statusCode).toBe(404);
    });
  });

  it('is for NovaCiel staff only, and shows nothing but the whitelisted, content-free fields', async () => {
    await withApp(async (ctx) => {
      const id = addJob(ctx, ctx.clienteId, {
        estado: 'failed',
        output: { message: 'SECRETO-DEL-ERROR', stack: 'at secret', resultado: 'hackeado', codigo: 'con espacios y SECRETO', guion_id: 'no-uuid' },
      });
      const url = `/clientes/${ctx.clienteId}/briefs/trabajos/${id}`;
      for (const rol of ['dueno_cliente', 'aprobador_cliente', 'colaborador_cliente'] as RoleCode[]) {
        expect((await get(ctx, await login(ctx, rol), url)).statusCode, rol).toBe(403);
      }
      expect((await get(ctx, null, url)).statusCode).toBe(401);
      const res = await get(ctx, await login(ctx, 'operador_novaciel'), url);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ tipo: 'plan', estado: 'failed', resultado: null, codigo: null, resumen: null, piezas: null, guion_id: null, version: null });
      expect(res.body).not.toMatch(/SECRETO|secret|hackeado/);

      // A valid result with junk next to it keeps only the whitelisted fields.
      const mixed = addJob(ctx, ctx.clienteId, { output: { resultado: 'rechazado', codigo: 'PlanNoAprobadoError', message: 'SECRETO', extra: { a: 1 } } });
      const body = (await get(ctx, await login(ctx, 'operador_novaciel'), `/clientes/${ctx.clienteId}/briefs/trabajos/${mixed}`)).json();
      expect(body).toMatchObject({ resultado: 'rechazado', codigo: 'PlanNoAprobadoError' });
      expect(JSON.stringify(body)).not.toContain('SECRETO');
    });
  });
});

describe('GET the brief of a piece', () => {
  it('shows the current brief, rendered, to staff and to the client owner and approver; not to collaborators', async () => {
    await withApp(async (ctx) => {
      const { pieza, guion } = await pieceWithBrief(ctx);
      const url = `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief`;
      for (const [rol, status] of [['administrador_novaciel', 200], ['operador_novaciel', 200], ['dueno_cliente', 200], ['aprobador_cliente', 200], ['colaborador_cliente', 403]] as [RoleCode, number][]) {
        expect((await get(ctx, await login(ctx, rol), url)).statusCode, rol).toBe(status);
      }
      expect((await get(ctx, null, url)).statusCode).toBe(401);
      const res = await get(ctx, await login(ctx, 'dueno_cliente'), url);
      const body = res.json();
      expect(body).toMatchObject({ id: guion.id, pieza_id: pieza.id, version: 1, es_actual: true, formato: 'carrusel', pieza_estado: 'guion_listo' });
      expect(body.contenido.gancho).toEqual(expect.any(String));
      expect(body.tomas).toEqual([]);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  it('never shows the model output with tokens, the prompt or an error message', async () => {
    await withApp(async (ctx) => {
      const rendered = { gancho: 'El café cuesta $6.000 COP', escenas: [], texto_publicacion: { texto: 'x', hashtags: [] }, llamado_a_accion: 'x', notas_produccion: 'x', hechos_omitidos: [] };
      const { pieza } = await pieceWithBrief(ctx, rendered);
      const admin = await login(ctx, 'administrador_novaciel');
      const one = await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief`);
      const all = await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief/versiones`);
      for (const res of [one, all]) {
        expect(res.body).not.toContain('{{hecho:');
        expect(res.body).not.toContain('contenido_modelo');
        expect(res.body).not.toMatch(/prompt|EXTERNAL_DATA/i);
      }
      expect(one.json().contenido.gancho).toBe('El café cuesta $6.000 COP');
    });
  });

  it('lists every version, oldest first, with the current one marked', async () => {
    await withApp(async (ctx) => {
      const { pieza } = await pieceWithBrief(ctx);
      await createGuion(ctx.db, { piezaId: pieza.id }); // version 2, retiring version 1
      const admin = await login(ctx, 'administrador_novaciel');
      const res = await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief/versiones`);
      expect(res.statusCode).toBe(200);
      expect(res.json().pieza_estado).toBe('guion_listo');
      expect(res.json().items.map((v: { version: number; es_actual: boolean }) => [v.version, v.es_actual])).toEqual([[1, false], [2, true]]);
      const current = await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief`);
      expect(current.json().version).toBe(2);
    });
  });

  it('gives 404 for a piece without a brief, another client\'s piece, unknown and malformed ids, and a discarded plan', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const { piezas } = await approvedPlan(ctx, 1);
      const without = `/clientes/${ctx.clienteId}/piezas/${piezas[0]!.id}/brief`;
      expect((await get(ctx, admin, without)).statusCode).toBe(404);
      expect((await get(ctx, admin, `${without}/versiones`)).json().items).toEqual([]);

      const other = asClienteId((await createCliente(ctx.db)).id);
      const otherPlan = await createPlanSemanal(ctx.db, { clienteId: other, estado: 'aprobado', semanaInicio: '2026-11-09' });
      const foreignPieza = await createPieza(ctx.db, { clienteId: other, planId: otherPlan.id, estado: 'plan_aprobado' });
      await createGuion(ctx.db, { piezaId: foreignPieza.id });
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${foreignPieza.id}/brief`)).statusCode).toBe(404);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${foreignPieza.id}/brief/versiones`)).statusCode).toBe(404);
      const owner = await login(ctx, 'dueno_cliente');
      expect((await get(ctx, owner, `/clientes/${other}/piezas/${foreignPieza.id}/brief`)).statusCode).toBe(403);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${randomUUID()}/brief`)).statusCode).toBe(404);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/not-a-uuid/brief`)).statusCode).toBe(404);

      const { plan, pieza } = await pieceWithBrief(ctx);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief`)).statusCode).toBe(200);
      await ctx.db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [plan.id]);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief`)).statusCode).toBe(404);
      expect((await get(ctx, admin, `/clientes/${ctx.clienteId}/piezas/${pieza.id}/brief/versiones`)).statusCode).toBe(404);
    });
  });
});

describe('plan approval is not an HTTP route', () => {
  it('has no route for aprobarPlanInterno: the matrix forbids NovaCiel approving for the client', async () => {
    await withApp(async (ctx) => {
      const { plan } = await approvedPlan(ctx);
      const draft = await createPlanSemanal(ctx.db, { clienteId: ctx.clienteId, perfilMarcaId: ctx.perfilId, semanaInicio: '2026-11-16' });
      const admin = await login(ctx, 'administrador_novaciel');
      for (const planId of [plan.id, draft.id]) {
        for (const suffix of ['aprobar-interno', 'aprobar', 'aprobacion', 'approve']) {
          for (const method of ['POST', 'PUT', 'PATCH'] as const) {
            const res = await ctx.app.inject({ method, url: `/clientes/${ctx.clienteId}/planes/${planId}/${suffix}`, headers: { ...JSON_HEADERS, ...admin.headers }, payload: {} });
            expect(res.statusCode, `${method} ${suffix}`).toBe(404);
          }
        }
      }
      const state = await ctx.db.query(`SELECT estado FROM planes_semanales WHERE id = $1`, [draft.id]);
      expect(state.rows[0].estado).toBe('borrador');
    });
  });
});
