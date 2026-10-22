import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import type { App } from '../auth/appType.js';
import { requirePermission, requireSession } from '../auth/authorize.js';
import { can } from '../auth/permissions.js';
import { InvalidTransitionError, PiezaNotFoundError, PlanDescartadoError } from '../piezas/errors.js';
import { getPieza, listPiezas } from '../piezas/piezasRepository.js';
import {
  PlanConPiezasPausadasError,
  PlanNoAprobadoError,
  PlanNotFoundError,
  PlanPiezasEnOtroEstadoError,
  PlanSinPiezasError,
} from '../planificador/errors.js';
import { toPiezaView, toPlanView } from '../planificador/planesView.js';
import { getPlan } from '../planificador/planesRepository.js';
import { getProduccionActual } from '../produccion/produccionRepository.js';
import { toProduccionPublica } from '../produccion/produccionView.js';
import { asClienteId } from '../shared/clienteId.js';
import type { AprobadorActor } from './actor.js';
import { esPersonalNovaciel } from './actor.js';
import {
  getHuellaPlan,
  getProduccionActualBasica,
  listHistorialAprobaciones,
  listPiezasPendientes,
  listPlanesPendientes,
  listRegistros,
} from './aprobacionesRepository.js';
import { registrarDecision } from './aprobacionesService.js';
import { etiquetaDispositivo } from './dispositivo.js';
import {
  AprobacionInvalidaError,
  HashDesactualizadoError,
  HuellaDesactualizadaError,
  PermisoDenegadoError,
  PiezaEstadoNoDecidibleError,
  PlanNoDecidibleError,
  PlanNoProponibleError,
  SinProduccionError,
} from './errors.js';
import { estadoAprobacion, type EstadoAprobacion } from './estadoAprobacion.js';
import { decidirPlan, proponerPlan } from './planAprobacionService.js';
import type { Recordatorios } from './recordatoriosPort.js';

// HTTP routes of the two-level approval (Step 9). Permissions per the matrix (section 14): NovaCiel
// decides the internal level, the client's approvers decide the client level, and a NovaCiel user can
// NEVER decide in the client's name (the service and the database both refuse it). Every decision carries
// the hash (or plan fingerprint) the approver was SHOWN; a different current one answers 409.
//
// Comments are client data. NovaCiel roles see every comment; client roles see the comments of the
// CLIENT level of their own client; the comments of the INTERNAL level are never shown to the client.
// They are never logged. Only the error name is logged.
//
// NOTE for clients: the CSRF guard of Step 2b requires Content-Type: application/json on every POST,
// also when the body is empty.

export interface AprobacionesRoutesOptions {
  db: Db;
  storage: Pick<Storage, 'getSignedUrl'>;
  /** Queues the reminders and the escalation notice inside the decision's transaction. Absent: none are queued. */
  recordatorios?: Recordatorios;
}

type Params = { clienteId: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_URL_TTL_SECONDS = 300;
const MAX_URL_TTL_SECONDS = 3600;

const MOTIVOS_PIEZA = ['texto', 'musica', 'toma', 'gancho', 'dato_equivocado', 'otro'] as const;
const MOTIVOS_PLAN = ['ideas', 'fechas', 'formatos', 'pilares', 'otro'] as const;

const piezaDecisionBody = z
  .object({
    nivel: z.enum(['interno', 'cliente']),
    decision: z.enum(['aprobada', 'cambios', 'rechazada']),
    hash_visto: z.string(),
    motivo: z.enum(MOTIVOS_PIEZA).optional(),
    segundo_ms: z.number().int().min(0).optional(),
    comentario: z.string().optional(),
    dispositivo: z.string().optional(),
  })
  .strict();
const planDecisionBody = z
  .object({
    decision: z.enum(['aprobado', 'cambios', 'rechazado']),
    huella_vista: z.string(),
    motivo: z.enum(MOTIVOS_PLAN).optional(),
    comentario: z.string().optional(),
    dispositivo: z.string().optional(),
  })
  .strict();
const vacio = z.object({}).strict().optional();
const urlQuery = z.object({ ttl: z.coerce.number().int().min(1).max(MAX_URL_TTL_SECONDS).default(DEFAULT_URL_TTL_SECONDS) }).strict();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalid = (reply: FastifyReply, fields?: readonly string[]) => reply.code(400).send({ error: 'invalid_request', ...(fields ? { fields } : {}) });
const fieldNames = (error: z.ZodError) => [...new Set(error.issues.map((i) => String(i.path[0] ?? 'request')))];
const actorOf = (req: FastifyRequest): AprobadorActor => ({ usuarioId: req.auth!.user.id, roles: req.auth!.roles });

/** The device label: what the client sent, if it is a short label; otherwise made from the User-Agent. */
const dispositivoDe = (req: FastifyRequest, enviado: string | undefined): string => {
  const limpio = enviado?.trim();
  return limpio && limpio.length <= 40 ? limpio : etiquetaDispositivo(req.headers['user-agent']);
};

/** Domain errors to HTTP answers. Anything else is rethrown (500, error name logged). */
function responder(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PermisoDenegadoError) return reply.code(403).send({ error: 'forbidden' });
  if (error instanceof PiezaNotFoundError || error instanceof PlanNotFoundError) return notFound(reply);
  if (error instanceof AprobacionInvalidaError) return invalid(reply, error.campos);
  if (error instanceof HashDesactualizadoError) return reply.code(409).send({ error: 'hash_desactualizado' });
  if (error instanceof HuellaDesactualizadaError) return reply.code(409).send({ error: 'huella_desactualizada' });
  if (error instanceof PiezaEstadoNoDecidibleError) return reply.code(409).send({ error: 'estado_invalido', estado: error.estado });
  if (error instanceof PlanNoDecidibleError || error instanceof PlanNoProponibleError) return reply.code(409).send({ error: 'estado_invalido', estado: error.estado });
  if (error instanceof PlanNoAprobadoError) return reply.code(409).send({ error: 'plan_no_aprobado', estado: error.estado });
  if (error instanceof PlanDescartadoError) return reply.code(409).send({ error: 'plan_descartado' });
  if (error instanceof SinProduccionError) return reply.code(409).send({ error: 'sin_produccion' });
  if (error instanceof PlanSinPiezasError) return reply.code(409).send({ error: 'plan_sin_piezas' });
  if (error instanceof PlanConPiezasPausadasError) return reply.code(409).send({ error: 'plan_con_piezas_pausadas' });
  if (error instanceof PlanPiezasEnOtroEstadoError) return reply.code(409).send({ error: 'piezas_en_otro_estado' });
  if (error instanceof InvalidTransitionError) return reply.code(409).send({ error: 'transicion_invalida' });
  throw error;
}

/** The approval state without the internal sequence numbers. */
const estadoPublico = (e: EstadoAprobacion): { estado: string; ronda?: number } =>
  e.estado === 'cambios_pedidos' ? { estado: e.estado, ronda: e.ronda } : { estado: e.estado };

export async function registerAprobacionesRoutes(app: App, options: AprobacionesRoutesOptions): Promise<void> {
  const { db, storage, recordatorios } = options;
  const deps = { db, ...(recordatorios ? { recordatorios } : {}) };
  const lectura = requirePermission(db, 'read_client_data', (req) => (req.params as Params).clienteId);
  const gestion = requirePermission(db, 'manage_plans', (req) => (req.params as Params).clienteId);
  const sesion = requireSession(db);

  await app.register(async (scope) => {
    // Signed URLs, hashes and comments must never be cached.
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    // Only the error name is logged: messages could carry request content.
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'approval route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    // ---- What waits for the caller's level ----
    scope.get<{ Params: Params }>('/clientes/:clienteId/aprobaciones/pendientes', { preHandler: lectura }, async (req, reply) => {
      const clienteId = asClienteId(req.params.clienteId);
      const roles = req.auth!.roles;
      if (can(roles, 'approve_internal', clienteId)) {
        const piezas = await listPiezasPendientes(db, clienteId, 'interno');
        return { nivel: 'interno', piezas: piezas.map((p) => ({ ...p, fecha_hora: p.fecha_hora.toISOString() })), planes: [] };
      }
      if (can(roles, 'approve_as_client', clienteId)) {
        const [piezas, planes] = await Promise.all([listPiezasPendientes(db, clienteId, 'cliente'), listPlanesPendientes(db, clienteId)]);
        return {
          nivel: 'cliente',
          piezas: piezas.map((p) => ({ ...p, fecha_hora: p.fecha_hora.toISOString() })),
          planes: planes.map((p) => ({ ...p, primer_plazo: p.primer_plazo.toISOString() })),
        };
      }
      return reply.code(403).send({ error: 'forbidden' });
    });

    // ---- A piece, as the approver must see it ----
    scope.get<{ Params: Params & { piezaId: string }; Querystring: Record<string, unknown> }>('/clientes/:clienteId/piezas/:piezaId/revision', { preHandler: lectura }, async (req, reply) => {
      const query = urlQuery.safeParse(req.query);
      if (!query.success) return invalid(reply, fieldNames(query.error));
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const pieza = await getPieza(db, clienteId, req.params.piezaId);
      const produccion = pieza ? await getProduccionActual(db, clienteId, pieza.id) : null;
      const actual = pieza ? await getProduccionActualBasica(db, clienteId, pieza.id) : null;
      if (!pieza || !produccion || !actual) return notFound(reply);

      const usuarioId = req.auth!.user.id;
      const esNovaciel = esPersonalNovaciel(actorOf(req));
      const historial = (await listHistorialAprobaciones(db, clienteId, pieza.id)).map((r) => ({
        nivel: r.nivel,
        decision: r.decision,
        motivo: r.motivo,
        segundo_ms: r.segundo_ms,
        version: r.version,
        creado_en: r.creado_en.toISOString(),
        propia: r.usuario_id === usuarioId,
        // NovaCiel reads every comment; a client role reads the client-level ones only.
        comentario: esNovaciel || r.nivel === 'cliente' ? r.comentario : null,
      }));
      return {
        ...(await toProduccionPublica(storage, produccion, query.data.ttl)),
        pieza_estado: pieza.estado,
        fecha_hora: pieza.fecha_hora.toISOString(),
        estado_aprobacion: estadoPublico(estadoAprobacion(actual, await listRegistros(db, clienteId, pieza.id))),
        historial,
      };
    });

    // ---- Decide on a piece ----
    scope.post<{ Params: Params & { piezaId: string } }>('/clientes/:clienteId/piezas/:piezaId/decision', { preHandler: sesion }, async (req, reply) => {
      const body = piezaDecisionBody.safeParse(req.body);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const b = body.data;
      try {
        const resultado = await registrarDecision(deps, asClienteId(req.params.clienteId), req.params.piezaId, actorOf(req), {
          nivel: b.nivel,
          decision: b.decision,
          hashVisto: b.hash_visto,
          ...(b.motivo !== undefined ? { motivo: b.motivo } : {}),
          ...(b.segundo_ms !== undefined ? { segundoMs: b.segundo_ms } : {}),
          ...(b.comentario !== undefined ? { comentario: b.comentario } : {}),
          dispositivo: dispositivoDe(req, b.dispositivo),
        });
        return {
          pieza_id: resultado.pieza.id,
          pieza_estado: resultado.pieza.estado,
          aprobacion_id: resultado.aprobacion.id,
          estado_aprobacion: estadoPublico(resultado.estadoAprobacion),
          rondas_de_cambios: resultado.escalada.rondas,
          escalada: resultado.escalada.escalada,
        };
      } catch (error) {
        return responder(reply, error);
      }
    });

    // ---- A proposed plan, as the approver must see it ----
    scope.get<{ Params: Params & { planId: string } }>('/clientes/:clienteId/planes/:planId/revision', { preHandler: lectura }, async (req, reply) => {
      if (!UUID_RE.test(req.params.planId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const plan = await getPlan(db, clienteId, req.params.planId);
      if (!plan || plan.estado === 'descartado') return notFound(reply);
      const piezas = await listPiezas(db, clienteId, { planId: plan.id });
      return {
        plan: toPlanView(plan),
        huella_plan: await getHuellaPlan(db, clienteId, plan.id),
        piezas: piezas.map((p) => toPiezaView(p, plan.zona_horaria)),
      };
    });

    // ---- NovaCiel shows the plan to the client ----
    scope.post<{ Params: Params & { planId: string } }>('/clientes/:clienteId/planes/:planId/proponer', { preHandler: gestion }, async (req, reply) => {
      const body = vacio.safeParse(req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.planId)) return notFound(reply);
      try {
        const { plan, piezas } = await proponerPlan(deps, asClienteId(req.params.clienteId), req.params.planId, actorOf(req));
        return reply.code(200).send({ plan_id: plan.id, estado: plan.estado, piezas: piezas.length });
      } catch (error) {
        return responder(reply, error);
      }
    });

    // ---- Decide on a plan ----
    scope.post<{ Params: Params & { planId: string } }>('/clientes/:clienteId/planes/:planId/decision', { preHandler: sesion }, async (req, reply) => {
      const body = planDecisionBody.safeParse(req.body);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.planId)) return notFound(reply);
      const b = body.data;
      try {
        const { plan, piezas } = await decidirPlan(deps, asClienteId(req.params.clienteId), req.params.planId, actorOf(req), {
          decision: b.decision,
          huellaVista: b.huella_vista,
          ...(b.motivo !== undefined ? { motivo: b.motivo } : {}),
          ...(b.comentario !== undefined ? { comentario: b.comentario } : {}),
          dispositivo: dispositivoDe(req, b.dispositivo),
        });
        return { plan_id: plan.id, estado: plan.estado, piezas: piezas.length };
      } catch (error) {
        return responder(reply, error);
      }
    });
  });
}
