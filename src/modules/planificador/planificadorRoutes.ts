import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { App } from '../auth/appType.js';
import { requirePermission } from '../auth/authorize.js';
import {
  InvalidPiezaInputError,
  InvalidTransitionError,
  NotPausedError,
  PiezaNotFoundError,
  PlanDescartadoError,
} from '../piezas/errors.js';
import { listPiezas } from '../piezas/piezasRepository.js';
import { pausarPieza, reanudarPieza } from '../piezas/piezasService.js';
import { asClienteId } from '../shared/clienteId.js';
import { NoPuedePlanificarError, PlanExistenteError, PlannerContextError } from './errors.js';
import { isValidLocalDate, mondayOf } from './fechas.js';
import { getPlan, listPlanes } from './planesRepository.js';
import { toPiezaView, toPlanView } from './planesView.js';
import { type GenerarPlanOutput, type PlanQueue } from './planificadorJobs.js';
import { assertPuedePlanificar, assertSemanaDisponible, normalizarSemana } from './planificadorService.js';

// HTTP routes of the weekly planner. Generating is asynchronous: the route checks everything it can
// without spending anything, queues the job and answers 202 with its id (a generation is a paid
// model call that can take a while, and an impatient client retrying would duplicate the spend; the
// job queue allows one per client and week). The result is read with GET /planes or the job route.
// NOTE for clients: the CSRF guard of Step 2b requires Content-Type: application/json on every
// POST, also when the body is empty.

export interface PlanificadorRoutesOptions {
  db: Db;
  queue: PlanQueue;
}

type Params = { clienteId: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const localDate = z.string().refine(isValidLocalDate, 'invalid date');
const generarBody = z.object({ semana: localDate, reemplazar: z.boolean().optional() }).strict();
const motivoBody = z.object({ motivo: z.string().optional() }).strict().optional();
const listQuery = z.object({ semana: localDate.optional() }).strict();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalid = (reply: FastifyReply, fields?: string[]) => reply.code(400).send({ error: 'invalid_request', ...(fields ? { fields } : {}) });
const fieldNames = (error: z.ZodError) => [...new Set(error.issues.map((i) => String(i.path[0] ?? 'request')))];

/** Only the whitelisted, content-free fields of a job output; anything else is dropped. */
function publicOutput(output: unknown): Partial<GenerarPlanOutput> {
  if (typeof output !== 'object' || output === null) return {};
  const o = output as Record<string, unknown>;
  if (o.resultado !== 'plan_creado' && o.resultado !== 'rechazado') return {};
  return {
    resultado: o.resultado,
    ...(typeof o.codigo === 'string' ? { codigo: o.codigo } : {}),
    ...(typeof o.plan_id === 'string' && UUID_RE.test(o.plan_id) ? { plan_id: o.plan_id } : {}),
  };
}

export async function registerPlanificadorRoutes(app: App, options: PlanificadorRoutesOptions): Promise<void> {
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
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'planner route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    // ---- Generate (queues a job) ----
    scope.post<{ Params: Params }>('/clientes/:clienteId/planes', { preHandler: permiso('manage_plans') }, async (req, reply) => {
      const body = generarBody.safeParse(req.body);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      const clienteId = asClienteId(req.params.clienteId);
      try {
        // Everything that can be refused for free is refused now, so no hopeless job is queued.
        const perfil = await assertPuedePlanificar(db, clienteId);
        const semana = normalizarSemana(perfil, body.data.semana);
        await assertSemanaDisponible(db, clienteId, semana, body.data.reemplazar ?? false);
        const jobId = await queue.enqueue({
          clienteId,
          semana,
          ...(body.data.reemplazar !== undefined ? { reemplazar: body.data.reemplazar } : {}),
        });
        if (jobId === null) return reply.code(409).send({ error: 'ya_en_cola', semana_inicio: semana });
        return reply.code(202).send({ job_id: jobId, semana_inicio: semana });
      } catch (error) {
        if (error instanceof NoPuedePlanificarError) {
          return reply.code(409).send({ error: 'no_puede_planificar', bloques: error.bloques });
        }
        if (error instanceof PlanExistenteError) {
          return reply.code(409).send({ error: 'plan_existente', plan_id: error.planId, estado: error.estado, reemplazable: error.reemplazable });
        }
        if (error instanceof PlannerContextError) return reply.code(409).send({ error: 'perfil_invalido', campo: error.field });
        throw error;
      }
    });

    // ---- Job status ----
    scope.get<{ Params: Params & { jobId: string } }>('/clientes/:clienteId/planes/trabajos/:jobId', { preHandler: permiso('manage_plans') }, async (req, reply) => {
      if (!UUID_RE.test(req.params.jobId)) return notFound(reply);
      const job = await queue.getJob(req.params.jobId);
      // A job of another client looks exactly like a job that does not exist.
      if (!job || job.clienteId !== req.params.clienteId) return notFound(reply);
      const output = publicOutput(job.output);
      return {
        estado: job.estado,
        resultado: output.resultado ?? null,
        codigo: output.codigo ?? null,
        plan_id: output.plan_id ?? null,
      };
    });

    // ---- Read plans ----
    scope.get<{ Params: Params }>('/clientes/:clienteId/planes', { preHandler: permiso('read_client_data') }, async (req, reply) => {
      const query = listQuery.safeParse(req.query);
      if (!query.success) return invalid(reply, fieldNames(query.error));
      const clienteId = asClienteId(req.params.clienteId);
      const planes = (await listPlanes(db, clienteId, query.data.semana ? { semana: mondayOf(query.data.semana) } : {})).filter((p) => p.estado !== 'descartado');
      const piezas = await listPiezas(db, clienteId);
      return {
        items: planes.map((plan) => ({ ...toPlanView(plan), piezas: piezas.filter((p) => p.plan_id === plan.id).length })),
      };
    });

    scope.get<{ Params: Params & { planId: string } }>('/clientes/:clienteId/planes/:planId', { preHandler: permiso('read_client_data') }, async (req, reply) => {
      if (!UUID_RE.test(req.params.planId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const plan = await getPlan(db, clienteId, req.params.planId);
      if (!plan) return notFound(reply);
      // A discarded plan can still be read (audit); its pieces are dead but visible here.
      const piezas = await listPiezas(db, clienteId, { planId: plan.id, includeDescartados: true });
      return { ...toPlanView(plan), piezas: piezas.map((p) => toPiezaView(p, plan.zona_horaria)) };
    });

    // ---- Pause and resume a piece (no other transition routes in this step) ----
    for (const accion of ['pausar', 'reanudar'] as const) {
      scope.post<{ Params: Params & { piezaId: string } }>(`/clientes/:clienteId/piezas/:piezaId/${accion}`, { preHandler: permiso('manage_plans') }, async (req, reply) => {
        const body = motivoBody.safeParse(req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined);
        if (!body.success) return invalid(reply, fieldNames(body.error));
        if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
        const clienteId = asClienteId(req.params.clienteId);
        const actor = { tipo: 'usuario', usuarioId: req.auth!.user.id } as const;
        const opciones = body.data?.motivo !== undefined ? { motivo: body.data.motivo } : {};
        try {
          const pieza = await (accion === 'pausar' ? pausarPieza : reanudarPieza)(db, clienteId, req.params.piezaId, actor, opciones);
          const plan = (await getPlan(db, clienteId, pieza.plan_id))!;
          return toPiezaView(pieza, plan.zona_horaria);
        } catch (error) {
          if (error instanceof PiezaNotFoundError) return notFound(reply);
          if (error instanceof InvalidTransitionError) return reply.code(409).send({ error: 'transicion_invalida', desde: error.desde, hacia: error.hacia });
          if (error instanceof NotPausedError) return reply.code(409).send({ error: 'no_pausada', estado: error.estado });
          if (error instanceof PlanDescartadoError) return reply.code(409).send({ error: 'plan_descartado' });
          if (error instanceof InvalidPiezaInputError) return invalid(reply, ['motivo']);
          throw error;
        }
      });
    }
  });
}
