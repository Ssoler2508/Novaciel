import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { PiezaNotFoundError, PlanDescartadoError } from '../piezas/errors.js';
import { listPiezas } from '../piezas/piezasRepository.js';
import { PlanNoAprobadoError, PlanNotFoundError } from '../planificador/errors.js';
import { getPlan } from '../planificador/planesRepository.js';
import type { JobEstado } from '../planificador/planificadorJobs.js';
import { asClienteId } from '../shared/clienteId.js';
import {
  BriefConFaltantesError,
  FormatoNoSoportadoError,
  FuentesMuyPequenasError,
  ImageDecodeError,
  ProduccionEstadoInvalidoError,
  ProduccionExistenteError,
  ProduccionHechoVencidoError,
  ProduccionMediaNoUsableError,
  ProduccionObsoletaError,
  SinBriefError,
  TextDoesNotFitError,
  UnsupportedGlyphsError,
} from './errors.js';
import { producirPieza, type ProduccionDeps } from './produccionService.js';

// The jobs of production, and the queue port the routes use. Production costs nothing, but a retry
// after a half-failure could store files twice, so jobs are never retried automatically and only one
// per piece (or per plan) can be queued or active at a time (queue policy "exclusive" + a singleton
// key). Logs and job outputs carry ids, counts and error NAMES only: never copy, text or file keys.

export const PRODUCIR_PIEZA_QUEUE = 'producir-pieza';
export const PRODUCIR_PLAN_QUEUE = 'producir-plan';

const payloadPiezaSchema = z.object({ clienteId: z.uuid(), piezaId: z.uuid(), reproducir: z.boolean().optional() }).strict();
const payloadPlanSchema = z.object({ clienteId: z.uuid(), planId: z.uuid() }).strict();
export type ProducirPiezaPayload = z.infer<typeof payloadPiezaSchema>;
export type ProducirPlanPayload = z.infer<typeof payloadPlanSchema>;

/** Slides whose source is too small: media ids and slide numbers only. */
export interface FuentesPequenas {
  media_ids: string[];
  ordenes: number[];
}

/** What the piece job leaves behind. */
export interface ProducirPiezaOutput {
  resultado: 'produccion_creada' | 'rechazado';
  codigo?: string;
  produccion_id?: string;
  version?: number;
  archivos?: number;
  hash_pieza?: string;
  fuentes_pequenas?: FuentesPequenas;
}

export interface ProducirPiezaEnPlan {
  pieza_id: string;
  resultado: 'ok' | 'fallida';
  version?: number;
  codigo?: string;
}

/** What the plan job leaves behind. */
export interface ProducirPlanOutput {
  resultado: 'plan_producido' | 'rechazado';
  codigo?: string;
  resumen?: { ok: number; fallidas: number };
  piezas?: ProducirPiezaEnPlan[];
}

export const singletonKeyPieza = (clienteId: string, piezaId: string) => `${clienteId}:${piezaId}`;
export const singletonKeyPlan = (clienteId: string, planId: string) => `${clienteId}:${planId}`;

// Expected domain errors: the job ends normally with resultado "rechazado". Anything else (a storage
// outage, a bug) fails the job.
const EXPECTED_PIEZA_ERRORS = [
  PiezaNotFoundError,
  PlanDescartadoError,
  PlanNoAprobadoError,
  ProduccionEstadoInvalidoError,
  FormatoNoSoportadoError,
  SinBriefError,
  BriefConFaltantesError,
  ProduccionExistenteError,
  ProduccionHechoVencidoError,
  ProduccionMediaNoUsableError,
  ProduccionObsoletaError,
  FuentesMuyPequenasError,
  TextDoesNotFitError,
  UnsupportedGlyphsError,
  ImageDecodeError,
] as const;
const EXPECTED_PLAN_ERRORS = [PlanNotFoundError, PlanNoAprobadoError, PlanDescartadoError] as const;

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'UnknownError');
const isExpected = (error: unknown, list: readonly (abstract new (...args: never[]) => Error)[]) => list.some((expected) => error instanceof expected);

/** Runs one piece job. Pure of pg-boss, so tests can call it directly. */
export async function ejecutarJobProducirPieza(deps: ProduccionDeps, data: unknown, jobId?: string): Promise<ProducirPiezaOutput> {
  const log = deps.logger ?? defaultLogger;
  const payload = payloadPiezaSchema.safeParse(data);
  if (!payload.success) {
    log.warn({ jobId, resultado: 'rechazado', codigo: 'PayloadInvalido' }, 'produce piece job rejected');
    return { resultado: 'rechazado', codigo: 'PayloadInvalido' };
  }
  const { clienteId, piezaId, reproducir } = payload.data;
  try {
    const { produccion } = await producirPieza(deps, asClienteId(clienteId), piezaId, { tipo: 'sistema' }, { reproducir: reproducir ?? false });
    log.info({ jobId, clienteId, piezaId, produccionId: produccion.id, version: produccion.version, archivos: produccion.archivos.length, resultado: 'produccion_creada' }, 'produce piece job done');
    return {
      resultado: 'produccion_creada',
      produccion_id: produccion.id,
      version: produccion.version,
      archivos: produccion.archivos.length,
      hash_pieza: produccion.hash_pieza,
    };
  } catch (error) {
    if (isExpected(error, EXPECTED_PIEZA_ERRORS)) {
      const codigo = errorName(error);
      log.warn({ jobId, clienteId, piezaId, resultado: 'rechazado', codigo }, 'produce piece job rejected');
      return {
        resultado: 'rechazado',
        codigo,
        ...(error instanceof FuentesMuyPequenasError ? { fuentes_pequenas: { media_ids: [...error.mediaIds], ordenes: [...error.ordenes] } } : {}),
      };
    }
    log.error({ jobId, clienteId, piezaId, errorName: errorName(error) }, 'produce piece job failed');
    throw error;
  }
}

/**
 * Runs one plan job: every piece of the plan waiting in guion_listo, one after the other. A piece
 * that cannot be produced is reported and does not stop the rest.
 */
export async function ejecutarJobProducirPlan(deps: ProduccionDeps, data: unknown, jobId?: string): Promise<ProducirPlanOutput> {
  const log = deps.logger ?? defaultLogger;
  const payload = payloadPlanSchema.safeParse(data);
  if (!payload.success) {
    log.warn({ jobId, resultado: 'rechazado', codigo: 'PayloadInvalido' }, 'produce plan job rejected');
    return { resultado: 'rechazado', codigo: 'PayloadInvalido' };
  }
  const { clienteId, planId } = payload.data;
  try {
    const cliente = asClienteId(clienteId);
    const plan = await getPlan(deps.db, cliente, planId);
    if (!plan) throw new PlanNotFoundError();
    if (plan.estado === 'descartado') throw new PlanDescartadoError();
    if (plan.estado !== 'aprobado') throw new PlanNoAprobadoError(plan.estado);
    const piezas: ProducirPiezaEnPlan[] = [];
    for (const pieza of await listPiezas(deps.db, cliente, { planId: plan.id, estado: 'guion_listo' })) {
      try {
        const { produccion } = await producirPieza(deps, cliente, pieza.id, { tipo: 'sistema' });
        piezas.push({ pieza_id: pieza.id, resultado: 'ok', version: produccion.version });
      } catch (error) {
        if (!isExpected(error, EXPECTED_PIEZA_ERRORS)) throw error;
        piezas.push({ pieza_id: pieza.id, resultado: 'fallida', codigo: errorName(error) });
      }
    }
    const resumen = { ok: piezas.filter((p) => p.resultado === 'ok').length, fallidas: piezas.filter((p) => p.resultado === 'fallida').length };
    log.info({ jobId, clienteId, planId, ...resumen, resultado: 'plan_producido' }, 'produce plan job done');
    return { resultado: 'plan_producido', resumen, piezas };
  } catch (error) {
    if (isExpected(error, EXPECTED_PLAN_ERRORS)) {
      const codigo = errorName(error);
      log.warn({ jobId, clienteId, planId, resultado: 'rechazado', codigo }, 'produce plan job rejected');
      return { resultado: 'rechazado', codigo };
    }
    log.error({ jobId, clienteId, planId, errorName: errorName(error) }, 'produce plan job failed');
    throw error;
  }
}

/** Registers both queues (exclusive, no automatic retries) and their workers. Call after boss.start(). */
export async function registerProduccionJobs(boss: PgBoss, deps: ProduccionDeps): Promise<void> {
  await boss.createQueue(PRODUCIR_PIEZA_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
  await boss.createQueue(PRODUCIR_PLAN_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 1800 });
  await boss.work<ProducirPiezaPayload, ProducirPiezaOutput>(PRODUCIR_PIEZA_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0]!;
    return ejecutarJobProducirPieza(deps, job.data, job.id);
  });
  await boss.work<ProducirPlanPayload, ProducirPlanOutput>(PRODUCIR_PLAN_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0]!;
    return ejecutarJobProducirPlan(deps, job.data, job.id);
  });
}

// ---- The port the routes use, so they can be tested without pg-boss.

export interface ProduccionJobInfo {
  tipo: 'plan' | 'pieza';
  estado: JobEstado;
  /** The client the job was queued for (from its payload). */
  clienteId: string | null;
  output: unknown;
}

export interface ProduccionQueue {
  /** Queues a piece. Null when one for the same piece is already queued or active. */
  enqueuePieza(payload: ProducirPiezaPayload): Promise<string | null>;
  /** Queues a plan run. Null when one for the same plan is already queued or active. */
  enqueuePlan(payload: ProducirPlanPayload): Promise<string | null>;
  /** The id of a plan run for this plan that is created (or waiting to retry) or active, else null. Best effort. */
  findActivePlanJob(clienteId: string, planId: string): Promise<string | null>;
  /** A job of either queue, by id. */
  getJob(jobId: string): Promise<ProduccionJobInfo | null>;
}

const ESTADO: Record<string, JobEstado> = { created: 'created', retry: 'created', active: 'active', completed: 'completed', cancelled: 'failed', failed: 'failed' };
const ACTIVE_STATES = new Set(['created', 'retry', 'active']);

export function createPgBossProduccionQueue(boss: PgBoss): ProduccionQueue {
  return {
    enqueuePieza: (payload) => boss.send(PRODUCIR_PIEZA_QUEUE, payload, { singletonKey: singletonKeyPieza(payload.clienteId, payload.piezaId) }),
    enqueuePlan: (payload) => boss.send(PRODUCIR_PLAN_QUEUE, payload, { singletonKey: singletonKeyPlan(payload.clienteId, payload.planId) }),
    async findActivePlanJob(clienteId, planId) {
      const jobs = await boss.findJobs(PRODUCIR_PLAN_QUEUE, { key: singletonKeyPlan(clienteId, planId) });
      return jobs.find((job) => ACTIVE_STATES.has(job.state))?.id ?? null;
    },
    async getJob(jobId) {
      for (const [queue, tipo] of [[PRODUCIR_PLAN_QUEUE, 'plan'], [PRODUCIR_PIEZA_QUEUE, 'pieza']] as const) {
        const job = await boss.getJobById<{ clienteId?: unknown }>(queue, jobId);
        if (!job) continue;
        return {
          tipo,
          estado: ESTADO[job.state] ?? 'failed',
          clienteId: typeof job.data?.clienteId === 'string' ? job.data.clienteId : null,
          output: job.output,
        };
      }
      return null;
    },
  };
}
