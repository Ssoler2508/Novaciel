import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { App } from '../auth/appType.js';
import { requirePermission } from '../auth/authorize.js';
import { PiezaNotFoundError, PlanDescartadoError } from '../piezas/errors.js';
import { getPieza, listPiezas } from '../piezas/piezasRepository.js';
import { PlanNoAprobadoError } from '../planificador/errors.js';
import { getPlan } from '../planificador/planesRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import { toBriefView } from './briefView.js';
import { assertPiezaElegible } from './directorService.js';
import type { BriefQueue, BriefsPlanOutput } from './directorJobs.js';
import { BriefExistenteError, PiezaEstadoInvalidoError } from './errors.js';
import { getBriefActual, listBriefVersions } from './guionesRepository.js';

// HTTP routes of the creative director. Generating is asynchronous, for one piece as for a whole
// plan: a brief is a paid model call that can take a while, and an impatient client retrying would
// duplicate the spend (the job queue allows one job per plan and per piece). The routes check
// everything that can be refused for free, queue the job and answer 202 with its id; the result is
// read with the job route or the brief routes.
//
// There is NO route to approve a plan on behalf of the client (aprobarPlanInterno is a service used
// only by a development script): the permission matrix forbids NovaCiel approving for the client.
//
// NOTE for clients: the CSRF guard of Step 2b requires Content-Type: application/json on every
// POST, also when the body is empty.

export interface DirectorRoutesOptions {
  db: Db;
  queue: BriefQueue;
}

type Params = { clienteId: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z]{1,60}$/;
const MOTIVO_RE = /^[a-z_]{1,60}$/;

const planBody = z.object({}).strict().optional();
const piezaBody = z.object({ regenerar: z.boolean().optional() }).strict().optional();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalid = (reply: FastifyReply, fields?: string[]) => reply.code(400).send({ error: 'invalid_request', ...(fields ? { fields } : {}) });
const fieldNames = (error: z.ZodError) => [...new Set(error.issues.map((i) => String(i.path[0] ?? 'request')))];

/** Only the whitelisted, content-free fields of a job output; anything else is dropped. */
function publicOutput(output: unknown): {
  resultado: string | null;
  codigo: string | null;
  resumen: BriefsPlanOutput['resumen'] | null;
  piezas: BriefsPlanOutput['piezas'] | null;
  guion_id: string | null;
  version: number | null;
} {
  const empty = { resultado: null, codigo: null, resumen: null, piezas: null, guion_id: null, version: null };
  if (typeof output !== 'object' || output === null) return empty;
  const o = output as Record<string, unknown>;
  if (o.resultado !== 'briefs_generados' && o.resultado !== 'brief_creado' && o.resultado !== 'rechazado') return empty;
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

  let resumen: BriefsPlanOutput['resumen'] | null = null;
  const r = o.resumen as Record<string, unknown> | undefined;
  if (r && int(r.ok) !== null && int(r.omitidas) !== null && int(r.fallidas) !== null && typeof r.detenido_por_presupuesto === 'boolean') {
    resumen = { ok: int(r.ok)!, omitidas: int(r.omitidas)!, fallidas: int(r.fallidas)!, detenido_por_presupuesto: r.detenido_por_presupuesto };
  }
  const piezas = Array.isArray(o.piezas)
    ? o.piezas.flatMap((raw): NonNullable<BriefsPlanOutput['piezas']> => {
        const p = raw as Record<string, unknown>;
        if (typeof p?.pieza_id !== 'string' || !UUID_RE.test(p.pieza_id)) return [];
        if (p.resultado !== 'ok' && p.resultado !== 'omitida' && p.resultado !== 'fallida') return [];
        return [
          {
            pieza_id: p.pieza_id,
            resultado: p.resultado,
            ...(int(p.version) !== null ? { version: int(p.version)! } : {}),
            ...(typeof p.motivo === 'string' && MOTIVO_RE.test(p.motivo) ? { motivo: p.motivo } : {}),
            ...(typeof p.codigo === 'string' && NAME_RE.test(p.codigo) ? { codigo: p.codigo } : {}),
          },
        ];
      })
    : null;
  return {
    resultado: o.resultado,
    codigo: typeof o.codigo === 'string' && NAME_RE.test(o.codigo) ? o.codigo : null,
    resumen,
    piezas,
    guion_id: typeof o.guion_id === 'string' && UUID_RE.test(o.guion_id) ? o.guion_id : null,
    version: int(o.version),
  };
}

export async function registerDirectorRoutes(app: App, options: DirectorRoutesOptions): Promise<void> {
  const { db, queue } = options;
  const permiso = (action: 'manage_plans' | 'read_client_data') =>
    requirePermission(db, action, (req) => (req.params as Params).clienteId);

  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    // Only the error name is logged: messages could carry request content.
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'director route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    // ---- Briefs of a whole plan (queues a job) ----
    scope.post<{ Params: Params & { planId: string } }>('/clientes/:clienteId/planes/:planId/briefs', { preHandler: permiso('manage_plans') }, async (req, reply) => {
      const body = planBody.safeParse(req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.planId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      // Everything that can be refused for free is refused now, so no hopeless job is queued.
      const plan = await getPlan(db, clienteId, req.params.planId);
      if (!plan) return notFound(reply);
      if (plan.estado === 'descartado') return reply.code(409).send({ error: 'plan_descartado' });
      if (plan.estado !== 'aprobado') return reply.code(409).send({ error: 'plan_no_aprobado', estado: plan.estado });
      const elegibles = await listPiezas(db, clienteId, { planId: plan.id, estado: 'plan_aprobado' });
      if (elegibles.length === 0) return reply.code(409).send({ error: 'sin_piezas_elegibles' });
      const jobId = await queue.enqueuePlan({ clienteId, planId: plan.id });
      if (jobId === null) return reply.code(409).send({ error: 'ya_en_cola' });
      return reply.code(202).send({ job_id: jobId, plan_id: plan.id });
    });

    // ---- The brief of one piece (queues a job) ----
    scope.post<{ Params: Params & { piezaId: string } }>('/clientes/:clienteId/piezas/:piezaId/brief', { preHandler: permiso('manage_plans') }, async (req, reply) => {
      const body = piezaBody.safeParse(req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const regenerar = body.data?.regenerar ?? false;
      try {
        // The same free checks as the service.
        const { pieza } = await assertPiezaElegible(db, clienteId, req.params.piezaId, regenerar);
        // Best effort: a plan run that is queued or active would write this piece too.
        const planJob = await queue.findActivePlanJob(clienteId, pieza.plan_id);
        if (planJob !== null) return reply.code(409).send({ error: 'plan_en_proceso', job_id: planJob });
        const jobId = await queue.enqueuePieza({ clienteId, piezaId: pieza.id, ...(body.data?.regenerar !== undefined ? { regenerar } : {}) });
        if (jobId === null) return reply.code(409).send({ error: 'ya_en_cola' });
        return reply.code(202).send({ job_id: jobId, pieza_id: pieza.id });
      } catch (error) {
        if (error instanceof PiezaNotFoundError) return notFound(reply);
        if (error instanceof PlanDescartadoError) return reply.code(409).send({ error: 'plan_descartado' });
        if (error instanceof PlanNoAprobadoError) return reply.code(409).send({ error: 'plan_no_aprobado', estado: error.estado });
        if (error instanceof PiezaEstadoInvalidoError) return reply.code(409).send({ error: 'estado_invalido', estado: error.estado });
        if (error instanceof BriefExistenteError) return reply.code(409).send({ error: 'brief_existente', version: error.version });
        throw error;
      }
    });

    // ---- Job status (either queue) ----
    scope.get<{ Params: Params & { jobId: string } }>('/clientes/:clienteId/briefs/trabajos/:jobId', { preHandler: permiso('manage_plans') }, async (req, reply) => {
      if (!UUID_RE.test(req.params.jobId)) return notFound(reply);
      const job = await queue.getJob(req.params.jobId);
      // A job of another client looks exactly like a job that does not exist.
      if (!job || job.clienteId !== req.params.clienteId) return notFound(reply);
      return { tipo: job.tipo, estado: job.estado, ...publicOutput(job.output) };
    });

    // ---- Read briefs ----
    scope.get<{ Params: Params & { piezaId: string } }>('/clientes/:clienteId/piezas/:piezaId/brief', { preHandler: permiso('read_client_data') }, async (req, reply) => {
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      // A piece of a discarded plan is dead: hidden, like in the plan routes.
      const pieza = await getPieza(db, clienteId, req.params.piezaId);
      const brief = pieza ? await getBriefActual(db, clienteId, pieza.id) : null;
      if (!pieza || !brief) return notFound(reply);
      return { ...toBriefView(brief), pieza_estado: pieza.estado };
    });

    scope.get<{ Params: Params & { piezaId: string } }>('/clientes/:clienteId/piezas/:piezaId/brief/versiones', { preHandler: permiso('read_client_data') }, async (req, reply) => {
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const pieza = await getPieza(db, clienteId, req.params.piezaId);
      if (!pieza) return notFound(reply);
      const versiones = await listBriefVersions(db, clienteId, pieza.id);
      return { pieza_estado: pieza.estado, items: versiones.map(toBriefView) };
    });
  });
}
