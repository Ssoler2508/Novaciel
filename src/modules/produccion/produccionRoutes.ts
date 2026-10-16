import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import type { App } from '../auth/appType.js';
import { requirePermission } from '../auth/authorize.js';
import { PiezaNotFoundError, PlanDescartadoError } from '../piezas/errors.js';
import { getPieza, listPiezas } from '../piezas/piezasRepository.js';
import { PlanNoAprobadoError } from '../planificador/errors.js';
import { getPlan } from '../planificador/planesRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import {
  BriefConFaltantesError,
  FormatoNoSoportadoError,
  ProduccionEstadoInvalidoError,
  ProduccionExistenteError,
  SinBriefError,
} from './errors.js';
import type { ProduccionQueue } from './produccionJobs.js';
import { getProduccionActual, listProduccionVersions } from './produccionRepository.js';
import { assertProducible } from './produccionService.js';
import { toProduccionPublica } from './produccionView.js';

// HTTP routes of production. Producing is asynchronous: rendering a carousel takes seconds and an
// impatient client retrying must not duplicate the work (the queue allows one job per piece and per
// plan). The routes check everything that can be refused for free, queue the job and answer 202 with
// its id; the result is read with the job route or the production routes. Producing is not an
// approval: nothing here publishes anything (approval of the exact files is Step 9).
//
// NOTE for clients: the CSRF guard of Step 2b requires Content-Type: application/json on every
// POST, also when the body is empty.

export interface ProduccionRoutesOptions {
  db: Db;
  queue: ProduccionQueue;
  storage: Pick<Storage, 'getSignedUrl'>;
}

type Params = { clienteId: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z]{1,60}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DEFAULT_URL_TTL_SECONDS = 300;
const MAX_URL_TTL_SECONDS = 3600;

const planBody = z.object({}).strict().optional();
const piezaBody = z.object({ reproducir: z.boolean().optional() }).strict().optional();
const urlQuery = z.object({ ttl: z.coerce.number().int().min(1).max(MAX_URL_TTL_SECONDS).default(DEFAULT_URL_TTL_SECONDS) }).strict();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalid = (reply: FastifyReply, fields?: string[]) => reply.code(400).send({ error: 'invalid_request', ...(fields ? { fields } : {}) });
const fieldNames = (error: z.ZodError) => [...new Set(error.issues.map((i) => String(i.path[0] ?? 'request')))];

/** Only the whitelisted, content-free fields of a job output; anything else is dropped. */
function publicOutput(output: unknown): Record<string, unknown> {
  const empty = { resultado: null, codigo: null, produccion_id: null, version: null, archivos: null, hash_pieza: null, fuentes_pequenas: null, resumen: null, piezas: null };
  if (typeof output !== 'object' || output === null) return empty;
  const o = output as Record<string, unknown>;
  if (o.resultado !== 'produccion_creada' && o.resultado !== 'plan_producido' && o.resultado !== 'rechazado') return empty;
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const uuid = (v: unknown) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

  const fp = o.fuentes_pequenas as Record<string, unknown> | undefined;
  const fuentes =
    fp && Array.isArray(fp.media_ids) && Array.isArray(fp.ordenes)
      ? { media_ids: fp.media_ids.filter((v): v is string => uuid(v) !== null), ordenes: fp.ordenes.filter((v): v is number => int(v) !== null) }
      : null;
  const r = o.resumen as Record<string, unknown> | undefined;
  const resumen = r && int(r.ok) !== null && int(r.fallidas) !== null ? { ok: int(r.ok)!, fallidas: int(r.fallidas)! } : null;
  const piezas = Array.isArray(o.piezas)
    ? o.piezas.flatMap((raw: unknown) => {
        const p = raw as Record<string, unknown>;
        if (uuid(p?.pieza_id) === null || (p.resultado !== 'ok' && p.resultado !== 'fallida')) return [];
        return [
          {
            pieza_id: p.pieza_id,
            resultado: p.resultado,
            ...(int(p.version) !== null ? { version: int(p.version) } : {}),
            ...(typeof p.codigo === 'string' && NAME_RE.test(p.codigo) ? { codigo: p.codigo } : {}),
          },
        ];
      })
    : null;
  return {
    resultado: o.resultado,
    codigo: typeof o.codigo === 'string' && NAME_RE.test(o.codigo) ? o.codigo : null,
    produccion_id: uuid(o.produccion_id),
    version: int(o.version),
    archivos: int(o.archivos),
    hash_pieza: typeof o.hash_pieza === 'string' && HEX64_RE.test(o.hash_pieza) ? o.hash_pieza : null,
    fuentes_pequenas: fuentes,
    resumen,
    piezas,
  };
}

export async function registerProduccionRoutes(app: App, options: ProduccionRoutesOptions): Promise<void> {
  const { db, queue, storage } = options;
  const permiso = (action: 'manage_plans' | 'read_client_data') =>
    requirePermission(db, action, (req) => (req.params as Params).clienteId);

  await app.register(async (scope) => {
    // Signed URLs and job state must never be cached.
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    // Only the error name is logged: messages could carry request content.
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'production route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    // ---- Produce one piece (queues a job) ----
    scope.post<{ Params: Params & { piezaId: string } }>('/clientes/:clienteId/piezas/:piezaId/produccion', { preHandler: permiso('manage_plans') }, async (req, reply) => {
      const body = piezaBody.safeParse(req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const reproducir = body.data?.reproducir ?? false;
      try {
        // The same free checks as the service.
        const { pieza } = await assertProducible(db, clienteId, req.params.piezaId, reproducir);
        // Best effort: a plan run that is queued or active would produce this piece too.
        const planJob = await queue.findActivePlanJob(clienteId, pieza.plan_id);
        if (planJob !== null) return reply.code(409).send({ error: 'plan_en_proceso', job_id: planJob });
        const jobId = await queue.enqueuePieza({ clienteId, piezaId: pieza.id, ...(body.data?.reproducir !== undefined ? { reproducir } : {}) });
        if (jobId === null) return reply.code(409).send({ error: 'ya_en_cola' });
        return reply.code(202).send({ job_id: jobId, pieza_id: pieza.id });
      } catch (error) {
        if (error instanceof PiezaNotFoundError) return notFound(reply);
        if (error instanceof PlanDescartadoError) return reply.code(409).send({ error: 'plan_descartado' });
        if (error instanceof PlanNoAprobadoError) return reply.code(409).send({ error: 'plan_no_aprobado', estado: error.estado });
        if (error instanceof ProduccionEstadoInvalidoError) return reply.code(409).send({ error: 'estado_invalido', estado: error.estado });
        if (error instanceof FormatoNoSoportadoError) return reply.code(409).send({ error: 'formato_no_soportado' });
        if (error instanceof SinBriefError) return reply.code(409).send({ error: 'sin_brief' });
        if (error instanceof BriefConFaltantesError) return reply.code(409).send({ error: 'brief_con_faltantes', ordenes: error.ordenes });
        if (error instanceof ProduccionExistenteError) return reply.code(409).send({ error: 'produccion_existente', version: error.version });
        throw error;
      }
    });

    // ---- Produce a whole plan (queues a job) ----
    scope.post<{ Params: Params & { planId: string } }>('/clientes/:clienteId/planes/:planId/produccion', { preHandler: permiso('manage_plans') }, async (req, reply) => {
      const body = planBody.safeParse(req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.planId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const plan = await getPlan(db, clienteId, req.params.planId);
      if (!plan) return notFound(reply);
      if (plan.estado === 'descartado') return reply.code(409).send({ error: 'plan_descartado' });
      if (plan.estado !== 'aprobado') return reply.code(409).send({ error: 'plan_no_aprobado', estado: plan.estado });
      const elegibles = await listPiezas(db, clienteId, { planId: plan.id, estado: 'guion_listo' });
      if (elegibles.length === 0) return reply.code(409).send({ error: 'sin_piezas_elegibles' });
      const jobId = await queue.enqueuePlan({ clienteId, planId: plan.id });
      if (jobId === null) return reply.code(409).send({ error: 'ya_en_cola' });
      return reply.code(202).send({ job_id: jobId, plan_id: plan.id });
    });

    // ---- Job status (either queue) ----
    scope.get<{ Params: Params & { jobId: string } }>('/clientes/:clienteId/produccion/trabajos/:jobId', { preHandler: permiso('manage_plans') }, async (req, reply) => {
      if (!UUID_RE.test(req.params.jobId)) return notFound(reply);
      const job = await queue.getJob(req.params.jobId);
      // A job of another client looks exactly like a job that does not exist.
      if (!job || job.clienteId !== req.params.clienteId) return notFound(reply);
      return { tipo: job.tipo, estado: job.estado, ...publicOutput(job.output) };
    });

    // ---- Read productions ----
    scope.get<{ Params: Params & { piezaId: string }; Querystring: Record<string, unknown> }>('/clientes/:clienteId/piezas/:piezaId/produccion', { preHandler: permiso('read_client_data') }, async (req, reply) => {
      const query = urlQuery.safeParse(req.query);
      if (!query.success) return invalid(reply, fieldNames(query.error));
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      // A piece of a discarded plan is dead: hidden, like in the plan routes.
      const pieza = await getPieza(db, clienteId, req.params.piezaId);
      const produccion = pieza ? await getProduccionActual(db, clienteId, pieza.id) : null;
      if (!pieza || !produccion) return notFound(reply);
      return { ...(await toProduccionPublica(storage, produccion, query.data.ttl)), pieza_estado: pieza.estado };
    });

    scope.get<{ Params: Params & { piezaId: string }; Querystring: Record<string, unknown> }>('/clientes/:clienteId/piezas/:piezaId/produccion/versiones', { preHandler: permiso('read_client_data') }, async (req, reply) => {
      const query = urlQuery.safeParse(req.query);
      if (!query.success) return invalid(reply, fieldNames(query.error));
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const pieza = await getPieza(db, clienteId, req.params.piezaId);
      if (!pieza) return notFound(reply);
      const versiones = await listProduccionVersions(db, clienteId, pieza.id);
      return { pieza_estado: pieza.estado, items: await Promise.all(versiones.map((v) => toProduccionPublica(storage, v, query.data.ttl))) };
    });
  });
}
