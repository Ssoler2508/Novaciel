import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { producibleWorld, type ProducibleWorld } from '../../../tests/utils/produccionWorld.js';
import { assignRole, createCliente, createPieza, createUsuario } from '../../../tests/utils/factories/index.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { registerAuth } from '../auth/authRoutes.js';
import type { RoleCode } from '../auth/permissions.js';
import { pausarPieza } from '../piezas/index.js';
import { asClienteId } from '../shared/clienteId.js';
import {
  singletonKeyPieza,
  singletonKeyPlan,
  type ProduccionJobInfo,
  type ProduccionQueue,
  type ProducirPiezaPayload,
  type ProducirPlanPayload,
} from './produccionJobs.js';
import { producirPieza } from './produccionService.js';
import { registerProduccionRoutes } from './produccionRoutes.js';

// Same pattern as directorRoutes.test.ts: one test-transaction client as Db, app.inject(), rollback.
// The queue is a fake (the real pg-boss is in produccionJobs.test.ts); storage is a FakeStorage.

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];
const SISTEMA = { tipo: 'sistema' } as const;

class FakeQueue implements ProduccionQueue {
  readonly planJobs: ProducirPlanPayload[] = [];
  readonly piezaJobs: ProducirPiezaPayload[] = [];
  readonly jobs = new Map<string, ProduccionJobInfo>();
  readonly busy = new Set<string>();
  readonly activePlan = new Map<string, string>();
  async enqueuePlan(payload: ProducirPlanPayload): Promise<string | null> {
    const key = `plan:${singletonKeyPlan(payload.clienteId, payload.planId)}`;
    if (this.busy.has(key)) return null;
    this.busy.add(key);
    const id = randomUUID();
    this.planJobs.push(payload);
    this.jobs.set(id, { tipo: 'plan', estado: 'created', clienteId: payload.clienteId, output: null });
    return id;
  }
  async enqueuePieza(payload: ProducirPiezaPayload): Promise<string | null> {
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
  async getJob(jobId: string): Promise<ProduccionJobInfo | null> {
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
  w: ProducibleWorld;
}

async function withApp(fn: (ctx: Ctx) => Promise<void>, world: Parameters<typeof producibleWorld>[1] = {}) {
  await withTestTransaction(async (db) => {
    const logs: string[] = [];
    const logger = createLogger('debug', { write: (l: string) => void logs.push(l) });
    const app = Fastify({ loggerInstance: logger });
    const queue = new FakeQueue();
    const w = await producibleWorld(db, world);
    await registerAuth(app, { db, allowedOrigin: ORIGIN });
    await registerProduccionRoutes(app, { db, queue, storage: w.storage });
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

const piezaUrl = (ctx: Ctx, piezaId = ctx.w.piezaId) => `/clientes/${ctx.w.clienteId}/piezas/${piezaId}/produccion`;
const planUrl = (ctx: Ctx, planId = ctx.w.planId) => `/clientes/${ctx.w.clienteId}/planes/${planId}/produccion`;

describe('POST /clientes/:clienteId/piezas/:piezaId/produccion', () => {
  it('queues a piece job for NovaCiel staff and answers 202 with the job id', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const res = await post(ctx, admin, piezaUrl(ctx), {});
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ job_id: expect.stringMatching(/^[0-9a-f-]{36}$/), pieza_id: ctx.w.piezaId });
      expect(ctx.queue.piezaJobs).toEqual([{ clienteId: ctx.w.clienteId, piezaId: ctx.w.piezaId }]);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  it('passes reproducir on, accepts an empty body, and rejects unknown fields', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'operador_novaciel');
      expect((await post(ctx, admin, piezaUrl(ctx), { reproducir: 'si' })).statusCode).toBe(400);
      expect((await post(ctx, admin, piezaUrl(ctx), { otro: true })).statusCode).toBe(400);
      expect(ctx.queue.queued).toBe(0);
      expect((await post(ctx, admin, piezaUrl(ctx))).statusCode).toBe(202); // no body at all
      expect(ctx.queue.piezaJobs[0]).toEqual({ clienteId: ctx.w.clienteId, piezaId: ctx.w.piezaId });
    });
  });

  it('answers 409 ya_en_cola for a second request and plan_en_proceso while a plan run is active', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      expect((await post(ctx, admin, piezaUrl(ctx), {})).statusCode).toBe(202);
      const second = await post(ctx, admin, piezaUrl(ctx), {});
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: 'ya_en_cola' });

      const other = await producibleWorld(ctx.db, { base: { clienteId: ctx.w.clienteId, planId: ctx.w.planId, perfilId: ctx.w.perfilId, storage: ctx.w.storage } });
      ctx.queue.activePlan.set(singletonKeyPlan(ctx.w.clienteId, ctx.w.planId), 'job-del-plan');
      const res = await post(ctx, admin, piezaUrl(ctx, other.piezaId), {});
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'plan_en_proceso', job_id: 'job-del-plan' });
    });
  });

  it('follows the matrix: the client roles, strangers and anonymous callers are refused, nothing is queued', async () => {
    await withApp(async (ctx) => {
      const other = asClienteId((await createCliente(ctx.db)).id);
      for (const s of [
        await login(ctx, 'dueno_cliente'),
        await login(ctx, 'aprobador_cliente'),
        await login(ctx, 'colaborador_cliente'),
        await login(ctx, 'dueno_cliente', other),
      ]) {
        expect((await post(ctx, s, piezaUrl(ctx), {})).statusCode).toBe(403);
      }
      expect((await post(ctx, null, piezaUrl(ctx), {})).statusCode).toBe(401);
      // CSRF: no JSON content type, no cross-site origin.
      const admin = await login(ctx, 'administrador_novaciel');
      expect((await ctx.app.inject({ method: 'POST', url: piezaUrl(ctx), headers: { ...admin.headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await post(ctx, admin, piezaUrl(ctx), {}, { origin: 'http://evil.example' })).statusCode).toBe(403);
      expect(ctx.queue.queued).toBe(0);
    });
  });

  it("refuses for free, with codes: nothing is queued for a piece that does not exist, belongs to another client, or cannot be produced", async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const refuse = async (url: string, status: number, body: unknown) => {
        const res = await post(ctx, admin, url, {});
        expect([res.statusCode, res.json()]).toEqual([status, body]);
      };
      await refuse(piezaUrl(ctx, randomUUID()), 404, { error: 'not_found' });
      await refuse(piezaUrl(ctx, 'no-es-un-uuid'), 404, { error: 'not_found' });

      // Another client's piece, asked under THIS client's id: it looks like a missing one.
      const foreign = await producibleWorld(ctx.db);
      await refuse(piezaUrl(ctx, foreign.piezaId), 404, { error: 'not_found' });

      const faltante = await producibleWorld(ctx.db, { faltantes: [2, 4], base: { clienteId: ctx.w.clienteId, planId: ctx.w.planId, perfilId: ctx.w.perfilId, storage: ctx.w.storage } });
      await refuse(piezaUrl(ctx, faltante.piezaId), 409, { error: 'brief_con_faltantes', ordenes: [2, 4] });

      const reel = await producibleWorld(ctx.db, { formato: 'reel', base: { clienteId: ctx.w.clienteId, planId: ctx.w.planId, perfilId: ctx.w.perfilId, storage: ctx.w.storage } });
      await refuse(piezaUrl(ctx, reel.piezaId), 409, { error: 'formato_no_soportado' });

      const sinBrief = await createPieza(ctx.db, { clienteId: ctx.w.clienteId, planId: ctx.w.planId, estado: 'plan_aprobado' });
      await refuse(piezaUrl(ctx, sinBrief.id), 409, { error: 'estado_invalido', estado: 'plan_aprobado' });

      const pausada = await producibleWorld(ctx.db, { base: { clienteId: ctx.w.clienteId, planId: ctx.w.planId, perfilId: ctx.w.perfilId, storage: ctx.w.storage } });
      await pausarPieza(ctx.db, ctx.w.clienteId, pausada.piezaId, SISTEMA);
      await refuse(piezaUrl(ctx, pausada.piezaId), 409, { error: 'estado_invalido', estado: 'pausada' });

      await producirPieza({ db: ctx.db, storage: ctx.w.storage }, ctx.w.clienteId, ctx.w.piezaId, SISTEMA);
      await refuse(piezaUrl(ctx), 409, { error: 'produccion_existente', version: 1 });
      expect((await post(ctx, admin, piezaUrl(ctx), { reproducir: true })).statusCode).toBe(202);

      await ctx.db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1 AND cliente_id = $2`, [ctx.w.planId, ctx.w.clienteId]);
      await refuse(piezaUrl(ctx, foreign.piezaId), 404, { error: 'not_found' });
      await refuse(piezaUrl(ctx, faltante.piezaId), 409, { error: 'plan_descartado' });
      expect(ctx.queue.queued).toBe(1); // only the reproducir request above
    });
  });
});

describe('POST /clientes/:clienteId/planes/:planId/produccion', () => {
  it('queues a plan job and answers 202; a second request is ya_en_cola', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const res = await post(ctx, admin, planUrl(ctx), {});
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ job_id: expect.stringMatching(/^[0-9a-f-]{36}$/), plan_id: ctx.w.planId });
      expect(ctx.queue.planJobs).toEqual([{ clienteId: ctx.w.clienteId, planId: ctx.w.planId }]);
      expect((await post(ctx, admin, planUrl(ctx), {})).json()).toEqual({ error: 'ya_en_cola' });
    });
  });

  it('answers sin_piezas_elegibles, plan_descartado, plan_no_aprobado, 404 and the matrix', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      expect((await post(ctx, admin, planUrl(ctx, randomUUID()), {})).statusCode).toBe(404);
      expect((await post(ctx, admin, planUrl(ctx, 'xx'), {})).statusCode).toBe(404);
      expect((await post(ctx, admin, planUrl(ctx), { algo: 1 })).statusCode).toBe(400);
      expect((await post(ctx, await login(ctx, 'dueno_cliente'), planUrl(ctx), {})).statusCode).toBe(403);
      expect((await post(ctx, null, planUrl(ctx), {})).statusCode).toBe(401);

      // The other client's plan, asked under this client's id: missing.
      const foreign = await producibleWorld(ctx.db);
      expect((await post(ctx, admin, planUrl(ctx, foreign.planId), {})).statusCode).toBe(404);

      await producirPieza({ db: ctx.db, storage: ctx.w.storage }, ctx.w.clienteId, ctx.w.piezaId, SISTEMA);
      expect((await post(ctx, admin, planUrl(ctx), {})).json()).toEqual({ error: 'sin_piezas_elegibles' });

      await ctx.db.query(`UPDATE planes_semanales SET estado = 'borrador' WHERE id = $1 AND cliente_id = $2`, [ctx.w.planId, ctx.w.clienteId]).catch(() => undefined);
      expect(ctx.queue.queued).toBe(0);
    });
  });
});

describe('GET /clientes/:clienteId/produccion/trabajos/:jobId', () => {
  it('shows only the whitelisted fields of the job, and a job of another client looks missing', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel');
      const queued = await post(ctx, admin, piezaUrl(ctx), {});
      const jobId = queued.json().job_id as string;
      const url = `/clientes/${ctx.w.clienteId}/produccion/trabajos/${jobId}`;
      expect((await get(ctx, admin, url)).json()).toMatchObject({ tipo: 'pieza', estado: 'created', resultado: null, codigo: null });

      ctx.queue.jobs.set(jobId, {
        tipo: 'pieza',
        estado: 'completed',
        clienteId: ctx.w.clienteId,
        output: {
          resultado: 'rechazado',
          codigo: 'FuentesMuyPequenasError',
          fuentes_pequenas: { media_ids: [ctx.w.media[0]!.id, 'no-uuid'], ordenes: [1, 2, -3] },
          clave: 'cliente/producidos/secreto.jpg',
          texto: 'COPY',
        },
      });
      const body = (await get(ctx, admin, url)).json();
      expect(body).toMatchObject({ estado: 'completed', resultado: 'rechazado', codigo: 'FuentesMuyPequenasError', fuentes_pequenas: { media_ids: [ctx.w.media[0]!.id], ordenes: [1, 2] } });
      expect(JSON.stringify(body)).not.toContain('secreto');
      expect(JSON.stringify(body)).not.toContain('COPY');

      expect((await get(ctx, admin, `/clientes/${ctx.w.clienteId}/produccion/trabajos/${randomUUID()}`)).statusCode).toBe(404);
      expect((await get(ctx, admin, `/clientes/${ctx.w.clienteId}/produccion/trabajos/nope`)).statusCode).toBe(404);
      expect((await get(ctx, await login(ctx, 'dueno_cliente'), url)).statusCode).toBe(403);

      // A job queued for ANOTHER client, asked under this one.
      ctx.queue.jobs.set('00000000-0000-4000-8000-0000000000aa', { tipo: 'pieza', estado: 'completed', clienteId: randomUUID(), output: { resultado: 'produccion_creada' } });
      expect((await get(ctx, admin, `/clientes/${ctx.w.clienteId}/produccion/trabajos/00000000-0000-4000-8000-0000000000aa`)).statusCode).toBe(404);
    });
  });
});

describe('GET /clientes/:clienteId/piezas/:piezaId/produccion (and /versiones)', () => {
  it('lists the files in order with signed URLs, dimensions, hashes and the piece hash, and never the storage key', async () => {
    await withApp(async (ctx) => {
      const { produccion } = await producirPieza({ db: ctx.db, storage: ctx.w.storage }, ctx.w.clienteId, ctx.w.piezaId, SISTEMA);
      const owner = await login(ctx, 'dueno_cliente');
      const res = await get(ctx, owner, piezaUrl(ctx));
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(body).toMatchObject({
        id: produccion.id,
        version: 1,
        es_actual: true,
        red: 'instagram',
        pieza_estado: 'en_control_calidad',
        texto_publicacion: 'Hecho con calma, como siempre.',
        hashtags: ['#cafe', '#origen'],
        ubicacion: 'Nuestro barrio',
        hash_version: 'np1',
        hash_pieza: produccion.hash_pieza,
      });
      expect(body.textos_alternativos).toHaveLength(5);
      expect(body.archivos.map((a: { orden: number }) => a.orden)).toEqual([1, 2, 3, 4, 5]);
      for (const [i, archivo] of body.archivos.entries()) {
        expect(archivo).toMatchObject({ mime: 'image/jpeg', ancho: 1080, alto: 1350, sha256: produccion.archivos[i]!.sha256, media_id: ctx.w.media[i]!.id, url_expira_en_s: 300 });
        // The URL points at the file: the key the fake storage signed is the stored one, and its bytes hash to the listed SHA-256.
        const key = produccion.archivos[i]!.clave_almacenamiento;
        expect(archivo.url).toContain(encodeURIComponent(key)); // the fake storage encodes the key in its URL
        expect(createHash('sha256').update(await ctx.w.storage.get(key)).digest('hex')).toBe(archivo.sha256);
      }
      expect(JSON.stringify(body)).not.toContain('clave_almacenamiento');

      // ttl is honoured and bounded.
      expect((await get(ctx, owner, `${piezaUrl(ctx)}?ttl=60`)).json().archivos[0].url_expira_en_s).toBe(60);
      expect((await get(ctx, owner, `${piezaUrl(ctx)}?ttl=99999`)).statusCode).toBe(400);
      expect((await get(ctx, owner, `${piezaUrl(ctx)}?otro=1`)).statusCode).toBe(400);
    });
  });

  it('lists every version after a re-production, oldest first, with the current one marked', async () => {
    await withApp(async (ctx) => {
      const deps = { db: ctx.db, storage: ctx.w.storage };
      await producirPieza(deps, ctx.w.clienteId, ctx.w.piezaId, SISTEMA);
      await producirPieza(deps, ctx.w.clienteId, ctx.w.piezaId, SISTEMA, { reproducir: true });
      const res = await get(ctx, await login(ctx, 'aprobador_cliente'), `${piezaUrl(ctx)}/versiones`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.pieza_estado).toBe('en_control_calidad');
      expect(body.items.map((v: { version: number; es_actual: boolean }) => [v.version, v.es_actual])).toEqual([[1, false], [2, true]]);
      expect((await get(ctx, await login(ctx, 'colaborador_cliente'), piezaUrl(ctx))).statusCode).toBe(403); // the matrix: no read_client_data
      expect((await get(ctx, await login(ctx, 'dueno_cliente'), piezaUrl(ctx))).json().version).toBe(2);
    });
  });

  it('answers 404 without a production, for another client, for a discarded plan, and refuses strangers and anonymous callers', async () => {
    await withApp(async (ctx) => {
      const owner = await login(ctx, 'dueno_cliente');
      expect((await get(ctx, owner, piezaUrl(ctx))).statusCode).toBe(404); // not produced yet
      expect((await get(ctx, owner, piezaUrl(ctx, randomUUID()))).statusCode).toBe(404);
      expect((await get(ctx, owner, piezaUrl(ctx, 'xx'))).statusCode).toBe(404);

      const other = await producibleWorld(ctx.db);
      await producirPieza({ db: ctx.db, storage: other.storage }, other.clienteId, other.piezaId, SISTEMA);
      expect((await get(ctx, owner, piezaUrl(ctx, other.piezaId))).statusCode).toBe(404); // under this client's id
      expect((await get(ctx, owner, `/clientes/${other.clienteId}/piezas/${other.piezaId}/produccion`)).statusCode).toBe(403); // under theirs
      expect((await get(ctx, null, piezaUrl(ctx))).statusCode).toBe(401);

      await producirPieza({ db: ctx.db, storage: ctx.w.storage }, ctx.w.clienteId, ctx.w.piezaId, SISTEMA);
      expect((await get(ctx, owner, piezaUrl(ctx))).statusCode).toBe(200);
      await ctx.db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1 AND cliente_id = $2`, [ctx.w.planId, ctx.w.clienteId]);
      expect((await get(ctx, owner, piezaUrl(ctx))).statusCode).toBe(404);
      expect((await get(ctx, owner, `${piezaUrl(ctx)}/versiones`)).statusCode).toBe(404);
    });
  });

  it('logs no copy, no keys', async () => {
    await withApp(async (ctx) => {
      await producirPieza({ db: ctx.db, storage: ctx.w.storage }, ctx.w.clienteId, ctx.w.piezaId, SISTEMA);
      const admin = await login(ctx, 'administrador_novaciel');
      await get(ctx, admin, piezaUrl(ctx));
      await post(ctx, admin, piezaUrl(ctx), {});
      const text = ctx.logs.join('\n');
      expect(text).not.toContain('Hecho con calma');
      expect(text).not.toContain('Escena');
      expect(text).not.toContain('producidos/');
    });
  });
});
