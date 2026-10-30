import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { App } from '../auth/appType.js';
import { requirePermission } from '../auth/authorize.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { getProduccionActual } from '../produccion/produccionRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import type { ControlCalidadQueue } from './controlCalidadJobs.js';
import { getUltimaRevisionDePieza, type RevisionView } from './revisionesRepository.js';

// Quality-control routes (Step 8), NovaCiel staff only (the matrix action "manage_plans"). The client
// roles see a summary inside the approval view of the piece (see aprobacionesRoutes), never these.
//
//   GET  /clientes/:clienteId/piezas/:piezaId/control-calidad   the latest report of the CURRENT production
//   POST /clientes/:clienteId/piezas/:piezaId/control-calidad   runs QC again (queues a job, answers 202)
//
// Reports carry ids, codes, numbers and fixed Spanish phrases: no text of the client. The CSRF guard
// requires Content-Type: application/json on every POST, also when the body is empty.

export interface ControlCalidadRoutesOptions {
  db: Db;
  queue: ControlCalidadQueue;
}

type Params = { clienteId: string; piezaId: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const vacio = z.object({}).strict().optional();

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

/** The report as the route shows it. */
export function toInformePublico(r: RevisionView) {
  return {
    id: r.id,
    produccion_id: r.produccion_id,
    version: r.produccion_version,
    hash_version: r.hash_version,
    hash_pieza: r.hash_pieza,
    resultado: r.resultado,
    checks: r.checks.map((c) => ({ codigo: c.codigo, resultado: c.resultado, severidad: c.severidad, motivo: c.motivo, parametros: c.parametros })),
    codigos_fallo: r.codigos_fallo,
    codigos_advertencia: r.checks.filter((c) => c.resultado === 'advertencia').map((c) => c.codigo),
    duracion_ms: r.duracion_ms,
    actor_tipo: r.actor_tipo,
    creado_en: r.creado_en.toISOString(),
  };
}

export async function registerControlCalidadRoutes(app: App, options: ControlCalidadRoutesOptions): Promise<void> {
  const { db, queue } = options;
  const gestion = requirePermission(db, 'manage_plans', (req) => (req.params as Params).clienteId);

  await app.register(async (scope) => {
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    // Only the error name is logged: messages could carry request content.
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'quality control route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    scope.get<{ Params: Params }>('/clientes/:clienteId/piezas/:piezaId/control-calidad', { preHandler: gestion }, async (req, reply) => {
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const pieza = await getPieza(db, clienteId, req.params.piezaId);
      // A piece of a discarded plan is dead: hidden, like in the plan routes.
      if (!pieza || pieza.plan_estado === 'descartado') return notFound(reply);
      const revision = await getUltimaRevisionDePieza(db, clienteId, pieza.id);
      return { pieza_estado: pieza.estado, vigente: revision !== null, informe: revision ? toInformePublico(revision) : null };
    });

    scope.post<{ Params: Params }>('/clientes/:clienteId/piezas/:piezaId/control-calidad', { preHandler: gestion }, async (req, reply) => {
      const body = vacio.safeParse(req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      if (!UUID_RE.test(req.params.piezaId)) return notFound(reply);
      const clienteId = asClienteId(req.params.clienteId);
      const pieza = await getPieza(db, clienteId, req.params.piezaId);
      // A piece of a discarded plan is dead: hidden, like in the GET.
      if (!pieza || pieza.plan_estado === 'descartado') return notFound(reply);
      if (pieza.plan_estado !== 'aprobado') return reply.code(409).send({ error: 'plan_no_aprobado', estado: pieza.plan_estado });
      if (pieza.estado !== 'en_control_calidad') return reply.code(409).send({ error: 'estado_invalido', estado: pieza.estado });
      const produccion = await getProduccionActual(db, clienteId, pieza.id);
      if (!produccion) return reply.code(409).send({ error: 'sin_produccion' });
      const jobId = await queue.enqueue({ clienteId, piezaId: pieza.id, produccionId: produccion.id });
      if (jobId === null) return reply.code(409).send({ error: 'ya_en_cola' });
      return reply.code(202).send({ job_id: jobId, pieza_id: pieza.id });
    });
  });
}
