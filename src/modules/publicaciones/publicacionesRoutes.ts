import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import type { App } from '../auth/appType.js';
import { requirePermission } from '../auth/authorize.js';
import type { AuditActor } from '../auditoria/recordAudit.js';
import {
  ArchivoAlteradoError,
  ControlCalidadNoAprobadoError,
  HashPiezaNoCoincideError,
  PiezaNoPublicableError,
  SinAprobacionVigenteError,
} from '../aprobaciones/errors.js';
import type { Recordatorios } from '../aprobaciones/recordatoriosPort.js';
import { InvalidTransitionError, PiezaNotFoundError, PlanDescartadoError } from '../piezas/errors.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { isValidLocalDate } from '../planificador/fechas.js';
import { ProduccionHechoVencidoError, ProduccionMediaNoUsableError } from '../produccion/errors.js';
import { asClienteId } from '../shared/clienteId.js';
import { PiezaEstadoProgramacionError, ProgramacionInvalidaError, PublicacionAbiertaError } from './errors.js';
import { getPublicacionPublicada, listResultadosSemana, listSnapshotsDePieza } from './medicionRepository.js';
import type { MetricasNormalizadas } from './normalizarMetricas.js';
import { cancelarProgramacion, programarPieza, reprogramarPieza } from './programacionService.js';
import type { PublicacionQueue } from './publicacionQueue.js';
import { listIntentosDePieza } from './publicacionesRepository.js';

// Publishing routes (Step 10, checkpoint D). All are ADDITIONS; no existing route changes.
//
//   POST /clientes/:clienteId/piezas/:piezaId/programacion            schedule (schedule_pieces)
//   PUT  /clientes/:clienteId/piezas/:piezaId/programacion            reschedule (schedule_pieces)
//   POST /clientes/:clienteId/piezas/:piezaId/programacion/cancelar   cancel the schedule (schedule_pieces)
//   GET  /clientes/:clienteId/piezas/:piezaId/publicaciones           attempt history (read_client_data)
//   GET  /clientes/:clienteId/piezas/:piezaId/resultados              metrics of one piece (read_client_data)
//   GET  /clientes/:clienteId/resultados?semana=YYYY-MM-DD            metrics of a client's week (read_client_data)
//
// Nothing here sends anything to a network: the send is a job. Attempt rows carry ids, closed error
// categories and links; never a provider message or a credential. The CSRF guard requires
// Content-Type: application/json on every POST/PUT, also when the body is empty.

export interface PublicacionesRoutesOptions {
  db: Db;
  storage: Storage;
  recordatorios?: Recordatorios;
  publicaciones?: PublicacionQueue;
  /** The clock for the scheduling rules. Default: the real one. */
  now?: () => Date;
}

type Params = { clienteId: string; piezaId: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const programacionBody = z.object({ fecha_hora: z.iso.datetime({ offset: true }) }).strict();
const cancelarBody = z.object({ motivo: z.string().trim().min(1).max(500) }).strict();
const semanaQuery = z.object({ semana: z.string().regex(FECHA_RE).refine(isValidLocalDate) }).strict();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalid = (reply: FastifyReply, fields?: readonly string[]) => reply.code(400).send({ error: 'invalid_request', ...(fields ? { fields } : {}) });
const fieldNames = (error: z.ZodError) => [...new Set(error.issues.map((i) => String(i.path[0] ?? 'request')))];
const actorOf = (req: FastifyRequest): AuditActor => ({ tipo: 'usuario', usuarioId: req.auth!.user.id });

/** Domain errors to HTTP answers. Anything else is rethrown (500, error name logged). */
function responder(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PiezaNotFoundError) return notFound(reply);
  if (error instanceof PiezaEstadoProgramacionError) return reply.code(409).send({ error: 'estado_invalido', estado: error.estado });
  if (error instanceof ProgramacionInvalidaError) return reply.code(400).send({ error: 'programacion_invalida', motivos: error.motivos });
  if (error instanceof PublicacionAbiertaError) return reply.code(409).send({ error: 'publicacion_en_curso' });
  if (error instanceof PlanDescartadoError) return reply.code(409).send({ error: 'plan_descartado' });
  if (error instanceof InvalidTransitionError) return reply.code(409).send({ error: 'transicion_invalida' });
  // The central gate: the piece is not publishable, and why (codes only).
  if (error instanceof PiezaNoPublicableError) return reply.code(409).send({ error: 'estado_invalido', estado: error.estado, plan_estado: error.planEstado });
  if (error instanceof SinAprobacionVigenteError) return reply.code(409).send({ error: 'sin_aprobacion_vigente', estado_aprobacion: error.estadoAprobacion });
  if (error instanceof ControlCalidadNoAprobadoError) return reply.code(409).send({ error: 'control_calidad_no_aprobado', estado_qc: error.estadoQc });
  if (error instanceof ArchivoAlteradoError) return reply.code(409).send({ error: 'archivo_alterado', orden: error.orden, motivo: error.motivo });
  if (error instanceof HashPiezaNoCoincideError) return reply.code(409).send({ error: 'hash_pieza_no_coincide', contra: error.contra });
  if (error instanceof ProduccionHechoVencidoError) return reply.code(409).send({ error: 'hecho_vencido' });
  if (error instanceof ProduccionMediaNoUsableError) return reply.code(409).send({ error: 'media_no_usable' });
  throw error;
}

const SUMAS: readonly (keyof MetricasNormalizadas)[] = [
  'impresiones',
  'alcance',
  'reproducciones',
  'me_gusta',
  'comentarios',
  'compartidos',
  'guardados',
  'visitas_perfil',
  'clics_enlace',
  'seguidores_ganados',
];

/** Sum of a metric over the pieces that report it; null when none does (never 0 for "unknown"). */
function sumar(filas: readonly (MetricasNormalizadas | null)[], clave: keyof MetricasNormalizadas): number | null {
  const valores = filas.map((f) => f?.[clave]).filter((v): v is number => typeof v === 'number');
  return valores.length === 0 ? null : valores.reduce((a, b) => a + b, 0);
}

export async function registerPublicacionesRoutes(app: App, options: PublicacionesRoutesOptions): Promise<void> {
  const { db, storage } = options;
  const deps = {
    db,
    storage,
    ...(options.recordatorios ? { recordatorios: options.recordatorios } : {}),
    ...(options.publicaciones ? { publicaciones: options.publicaciones } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const lectura = requirePermission(db, 'read_client_data', (req) => (req.params as Params).clienteId);
  const programacion = requirePermission(db, 'schedule_pieces', (req) => (req.params as Params).clienteId);

  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    // Only the error name is logged: messages could carry request content.
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'publishing route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    const vistaPieza = (p: { id: string; estado: string; fecha_hora: Date }) => ({ pieza_id: p.id, estado: p.estado, fecha_hora: p.fecha_hora.toISOString() });

    // ---- Schedule, reschedule, cancel ----
    scope.post<{ Params: Params }>('/clientes/:clienteId/piezas/:piezaId/programacion', { preHandler: programacion }, async (req, reply) => {
      const body = programacionBody.safeParse(req.body);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      try {
        const pieza = await programarPieza(deps, asClienteId(req.params.clienteId), req.params.piezaId, new Date(body.data.fecha_hora), actorOf(req));
        return vistaPieza(pieza);
      } catch (error) {
        return responder(reply, error);
      }
    });

    scope.put<{ Params: Params }>('/clientes/:clienteId/piezas/:piezaId/programacion', { preHandler: programacion }, async (req, reply) => {
      const body = programacionBody.safeParse(req.body);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      try {
        const pieza = await reprogramarPieza(deps, asClienteId(req.params.clienteId), req.params.piezaId, new Date(body.data.fecha_hora), actorOf(req));
        return vistaPieza(pieza);
      } catch (error) {
        return responder(reply, error);
      }
    });

    scope.post<{ Params: Params }>('/clientes/:clienteId/piezas/:piezaId/programacion/cancelar', { preHandler: programacion }, async (req, reply) => {
      const body = cancelarBody.safeParse(req.body);
      if (!body.success) return invalid(reply, fieldNames(body.error));
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      try {
        const pieza = await cancelarProgramacion(deps, asClienteId(req.params.clienteId), req.params.piezaId, actorOf(req), body.data.motivo);
        return vistaPieza(pieza);
      } catch (error) {
        return responder(reply, error);
      }
    });

    // ---- History of a piece ----
    scope.get<{ Params: Params }>('/clientes/:clienteId/piezas/:piezaId/publicaciones', { preHandler: lectura }, async (req, reply) => {
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const pieza = await getPieza(db, clienteId, req.params.piezaId);
      if (!pieza || pieza.plan_estado === 'descartado') return notFound(reply);
      const intentos = await listIntentosDePieza(db, clienteId, pieza.id);
      return {
        pieza_id: pieza.id,
        pieza_estado: pieza.estado,
        fecha_hora: pieza.fecha_hora.toISOString(),
        intentos: intentos.map((i) => ({
          numero_intento: i.numero_intento,
          proveedor: i.proveedor,
          red: i.red,
          estado: i.resultado ?? 'enviando',
          categoria_error: i.categoria_error,
          id_externo: i.id_externo,
          enlace: i.enlace,
          etiqueta_ia: i.etiqueta_ia,
          creado_en: i.creado_en.toISOString(),
          resultado_en: i.resultado_en ? i.resultado_en.toISOString() : null,
        })),
      };
    });

    // ---- Results of a piece ----
    scope.get<{ Params: Params }>('/clientes/:clienteId/piezas/:piezaId/resultados', { preHandler: lectura }, async (req, reply) => {
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const pieza = await getPieza(db, clienteId, req.params.piezaId);
      if (!pieza || pieza.plan_estado === 'descartado') return notFound(reply);
      const publicada = await getPublicacionPublicada(db, clienteId, pieza.id);
      const snapshots = publicada ? await listSnapshotsDePieza(db, clienteId, pieza.id) : [];
      return {
        pieza_id: pieza.id,
        pieza_estado: pieza.estado,
        publicada: publicada !== null,
        publicada_en: publicada ? publicada.publicada_en.toISOString() : null,
        enlace: publicada?.enlace ?? null,
        snapshots: snapshots.map((s) => ({ ventana: s.ventana, recogida_en: s.recogida_en.toISOString(), metricas: s.metricas })),
      };
    });

    // ---- Results of a client's week, for the dashboard ----
    scope.get<{ Params: { clienteId: string }; Querystring: Record<string, unknown> }>('/clientes/:clienteId/resultados', { preHandler: lectura }, async (req, reply) => {
      const query = semanaQuery.safeParse(req.query);
      if (!query.success) return invalid(reply, fieldNames(query.error));
      const clienteId = asClienteId(req.params.clienteId);
      const filas = await listResultadosSemana(db, clienteId, query.data.semana);
      return {
        semana: query.data.semana,
        piezas: filas.map((f) => ({
          pieza_id: f.pieza_id,
          red: f.red,
          formato: f.formato,
          publicada_en: f.publicada_en.toISOString(),
          enlace: f.enlace,
          ventana: f.ventana,
          recogida_en: f.recogida_en ? f.recogida_en.toISOString() : null,
          metricas: f.metricas,
        })),
        totales: {
          piezas_publicadas: filas.length,
          piezas_con_metricas: filas.filter((f) => f.metricas !== null).length,
          ...Object.fromEntries(SUMAS.map((k) => [k, sumar(filas.map((f) => f.metricas), k)])),
        },
      };
    });
  });
}
