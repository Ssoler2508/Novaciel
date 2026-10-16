import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { SchemaValidationError } from '../ai/generateStructured.js';
import { PiezaNotFoundError, PlanDescartadoError } from '../piezas/errors.js';
import { PlanNoAprobadoError, PlanNotFoundError } from '../planificador/errors.js';
import type { JobEstado } from '../planificador/planificadorJobs.js';
import { PriceNotFoundError } from '../precios/preciosRepository.js';
import { BudgetRefusedError } from '../presupuesto/presupuestoService.js';
import { asClienteId } from '../shared/clienteId.js';
import { generarBrief, generarBriefsDelPlan, type DirectorDeps } from './directorService.js';
import {
  BriefContextError,
  BriefExistenteError,
  BriefHechoVencidoError,
  BriefMediaNoUsableError,
  BriefObsoletoError,
  PiezaEstadoInvalidoError,
} from './errors.js';

// The jobs of the creative director, and the queue port the routes use. A brief is a paid model
// call, so jobs are never retried automatically and only one per plan (or per piece) can be queued
// or active at a time (queue policy "exclusive" + a singleton key). Logs and job outputs carry ids,
// counts and error NAMES only: never prompts, model output, copy, ideas or client content.

export const GENERAR_BRIEFS_PLAN_QUEUE = 'generar-briefs-plan';
export const GENERAR_BRIEF_PIEZA_QUEUE = 'generar-brief-pieza';

const payloadPlanSchema = z.object({ clienteId: z.uuid(), planId: z.uuid() }).strict();
const payloadPiezaSchema = z.object({ clienteId: z.uuid(), piezaId: z.uuid(), regenerar: z.boolean().optional() }).strict();
export type BriefsPlanPayload = z.infer<typeof payloadPlanSchema>;
export type BriefPiezaPayload = z.infer<typeof payloadPiezaSchema>;

export interface PiezaOutput {
  pieza_id: string;
  resultado: 'ok' | 'omitida' | 'fallida';
  version?: number;
  motivo?: string;
  codigo?: string;
}

/** What the plan job leaves behind. No content: counts, ids and error names. */
export interface BriefsPlanOutput {
  resultado: 'briefs_generados' | 'rechazado';
  codigo?: string;
  resumen?: { ok: number; omitidas: number; fallidas: number; detenido_por_presupuesto: boolean };
  piezas?: PiezaOutput[];
}

/** What the piece job leaves behind. */
export interface BriefPiezaOutput {
  resultado: 'brief_creado' | 'rechazado';
  codigo?: string;
  guion_id?: string;
  version?: number;
}

/** One job per plan / per piece. */
export const singletonKeyPlan = (clienteId: string, planId: string) => `${clienteId}:${planId}`;
export const singletonKeyPieza = (clienteId: string, piezaId: string) => `${clienteId}:${piezaId}`;

// Expected domain errors: the job ends normally with resultado "rechazado". Anything else is a bug
// or an outage and fails the job.
const EXPECTED_PLAN_ERRORS = [PlanNotFoundError, PlanNoAprobadoError, PlanDescartadoError, BriefContextError] as const;
const EXPECTED_PIEZA_ERRORS = [
  ...EXPECTED_PLAN_ERRORS,
  PiezaNotFoundError,
  PiezaEstadoInvalidoError,
  BriefExistenteError,
  BriefObsoletoError,
  BriefHechoVencidoError,
  BriefMediaNoUsableError,
  SchemaValidationError,
  BudgetRefusedError,
  PriceNotFoundError,
] as const;

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'UnknownError');

/** Runs one plan job. Pure of pg-boss, so tests can call it directly. */
export async function ejecutarJobBriefsPlan(deps: DirectorDeps, data: unknown, jobId?: string): Promise<BriefsPlanOutput> {
  const log = deps.logger ?? defaultLogger;
  const payload = payloadPlanSchema.safeParse(data);
  if (!payload.success) {
    log.warn({ jobId, resultado: 'rechazado', codigo: 'PayloadInvalido' }, 'plan briefs job rejected');
    return { resultado: 'rechazado', codigo: 'PayloadInvalido' };
  }
  const { clienteId, planId } = payload.data;
  try {
    const result = await generarBriefsDelPlan(deps, asClienteId(clienteId), planId, { tipo: 'sistema' });
    const piezas: PiezaOutput[] = result.resultados.map((r) => ({
      pieza_id: r.piezaId,
      resultado: r.resultado,
      ...(r.version !== undefined ? { version: r.version } : {}),
      ...(r.motivo !== undefined ? { motivo: r.motivo } : {}),
      ...(r.codigo !== undefined ? { codigo: r.codigo } : {}),
    }));
    const count = (resultado: PiezaOutput['resultado']) => piezas.filter((p) => p.resultado === resultado).length;
    const resumen = { ok: count('ok'), omitidas: count('omitida'), fallidas: count('fallida'), detenido_por_presupuesto: result.detenidoPorPresupuesto };
    log.info({ jobId, clienteId, planId, ...resumen, resultado: 'briefs_generados' }, 'plan briefs job done');
    return { resultado: 'briefs_generados', resumen, piezas };
  } catch (error) {
    if (EXPECTED_PLAN_ERRORS.some((expected) => error instanceof expected)) {
      const codigo = errorName(error);
      log.warn({ jobId, clienteId, planId, resultado: 'rechazado', codigo }, 'plan briefs job rejected');
      return { resultado: 'rechazado', codigo };
    }
    log.error({ jobId, clienteId, planId, errorName: errorName(error) }, 'plan briefs job failed');
    throw error;
  }
}

/** Runs one piece job. Pure of pg-boss. */
export async function ejecutarJobBriefPieza(deps: DirectorDeps, data: unknown, jobId?: string): Promise<BriefPiezaOutput> {
  const log = deps.logger ?? defaultLogger;
  const payload = payloadPiezaSchema.safeParse(data);
  if (!payload.success) {
    log.warn({ jobId, resultado: 'rechazado', codigo: 'PayloadInvalido' }, 'piece brief job rejected');
    return { resultado: 'rechazado', codigo: 'PayloadInvalido' };
  }
  const { clienteId, piezaId, regenerar } = payload.data;
  try {
    const result = await generarBrief(deps, asClienteId(clienteId), piezaId, { tipo: 'sistema' }, { regenerar: regenerar ?? false });
    log.info({ jobId, clienteId, piezaId, guionId: result.guion.id, version: result.guion.version, resultado: 'brief_creado' }, 'piece brief job done');
    return { resultado: 'brief_creado', guion_id: result.guion.id, version: result.guion.version };
  } catch (error) {
    if (EXPECTED_PIEZA_ERRORS.some((expected) => error instanceof expected)) {
      const codigo = errorName(error);
      log.warn({ jobId, clienteId, piezaId, resultado: 'rechazado', codigo }, 'piece brief job rejected');
      return { resultado: 'rechazado', codigo };
    }
    log.error({ jobId, clienteId, piezaId, errorName: errorName(error) }, 'piece brief job failed');
    throw error;
  }
}

/** Registers both queues (exclusive, no automatic retries) and their workers. Call after boss.start(). */
export async function registerDirectorJobs(boss: PgBoss, deps: DirectorDeps): Promise<void> {
  // A plan run is up to 14 sequential model calls; a single piece is one.
  await boss.createQueue(GENERAR_BRIEFS_PLAN_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 1800 });
  await boss.createQueue(GENERAR_BRIEF_PIEZA_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
  await boss.work<BriefsPlanPayload, BriefsPlanOutput>(GENERAR_BRIEFS_PLAN_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0]!;
    return ejecutarJobBriefsPlan(deps, job.data, job.id);
  });
  await boss.work<BriefPiezaPayload, BriefPiezaOutput>(GENERAR_BRIEF_PIEZA_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0]!;
    return ejecutarJobBriefPieza(deps, job.data, job.id);
  });
}

// ---- The port the routes use, so they can be tested without pg-boss.

export interface BriefJobInfo {
  tipo: 'plan' | 'pieza';
  estado: JobEstado;
  /** The client the job was queued for (from its payload). */
  clienteId: string | null;
  output: unknown;
}

export interface BriefQueue {
  /** Queues a plan run. Null when one for the same plan is already queued or active. */
  enqueuePlan(payload: BriefsPlanPayload): Promise<string | null>;
  /** Queues a piece brief. Null when one for the same piece is already queued or active. */
  enqueuePieza(payload: BriefPiezaPayload): Promise<string | null>;
  /**
   * The id of a plan run for this plan that is created (or waiting to retry) or active, else null.
   * Best effort: it narrows the race between a plan run and a piece job, it does not close it
   * (BriefObsoletoError is the backstop).
   */
  findActivePlanJob(clienteId: string, planId: string): Promise<string | null>;
  /** A job of either queue, by id. */
  getJob(jobId: string): Promise<BriefJobInfo | null>;
}

const ESTADO: Record<string, JobEstado> = { created: 'created', retry: 'created', active: 'active', completed: 'completed', cancelled: 'failed', failed: 'failed' };
const ACTIVE_STATES = new Set(['created', 'retry', 'active']);

export function createPgBossBriefQueue(boss: PgBoss): BriefQueue {
  return {
    enqueuePlan: (payload) => boss.send(GENERAR_BRIEFS_PLAN_QUEUE, payload, { singletonKey: singletonKeyPlan(payload.clienteId, payload.planId) }),
    enqueuePieza: (payload) => boss.send(GENERAR_BRIEF_PIEZA_QUEUE, payload, { singletonKey: singletonKeyPieza(payload.clienteId, payload.piezaId) }),
    async findActivePlanJob(clienteId, planId) {
      const jobs = await boss.findJobs(GENERAR_BRIEFS_PLAN_QUEUE, { key: singletonKeyPlan(clienteId, planId) });
      return jobs.find((job) => ACTIVE_STATES.has(job.state))?.id ?? null;
    },
    async getJob(jobId) {
      for (const [queue, tipo] of [[GENERAR_BRIEFS_PLAN_QUEUE, 'plan'], [GENERAR_BRIEF_PIEZA_QUEUE, 'pieza']] as const) {
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
