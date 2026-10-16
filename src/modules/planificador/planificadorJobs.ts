import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { z } from 'zod';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { SchemaValidationError } from '../ai/generateStructured.js';
import { PriceNotFoundError } from '../precios/preciosRepository.js';
import { BudgetRefusedError } from '../presupuesto/presupuestoService.js';
import { asClienteId } from '../shared/clienteId.js';
import { HechoVencidoError, NoPuedePlanificarError, PlanExistenteError, PlannerContextError } from './errors.js';
import { isValidLocalDate } from './fechas.js';
import { generarPlanSemanal, type PlanificadorDeps } from './planificadorService.js';

// The job that generates a weekly plan, and the queue port the routes use. A generation is a paid
// model call, so jobs are never retried automatically and only one per client and week can be
// queued or active at a time (queue policy "exclusive" + a singleton key). Logs and job outputs
// carry ids and error NAMES only: never prompts, model output, ideas or client content.
//
// There is NO automatic weekly schedule: the spec says the plan is produced "once a week per
// client" but does not say when. Known debt until NovaCiel decides the day and time.

export const GENERAR_PLAN_QUEUE = 'generar-plan-semanal';

const payloadSchema = z
  .object({
    clienteId: z.uuid(),
    /** The Monday of the week in the client's zone, YYYY-MM-DD (already normalized by the caller). */
    semana: z.string().refine(isValidLocalDate),
    reemplazar: z.boolean().optional(),
  })
  .strict();
export type GenerarPlanPayload = z.infer<typeof payloadSchema>;

/** What a finished job leaves behind. No content: a result, an error name, and a plan id. */
export interface GenerarPlanOutput {
  resultado: 'plan_creado' | 'rechazado';
  /** The error class name of an expected rejection (for example "NoPuedePlanificarError"). */
  codigo?: string;
  plan_id?: string;
}

/** One job per client and week, whichever date of the week was asked for. */
export function singletonKeyFor(clienteId: string, semana: string): string {
  return `${clienteId}:${semana}`;
}

// Expected domain errors: the job ends normally with resultado "rechazado". Anything else is a bug
// or an outage and fails the job.
const EXPECTED_ERRORS = [
  NoPuedePlanificarError,
  PlanExistenteError,
  BudgetRefusedError,
  SchemaValidationError,
  HechoVencidoError,
  PlannerContextError,
  PriceNotFoundError,
] as const;

/** Runs one job. Pure of pg-boss, so tests can call it directly. */
export async function ejecutarJobGenerarPlan(
  deps: PlanificadorDeps & { logger?: Logger },
  data: unknown,
  jobId?: string,
): Promise<GenerarPlanOutput> {
  const log = deps.logger ?? defaultLogger;
  const payload = payloadSchema.safeParse(data);
  if (!payload.success) {
    log.warn({ jobId, resultado: 'rechazado', codigo: 'PayloadInvalido' }, 'weekly plan job rejected');
    return { resultado: 'rechazado', codigo: 'PayloadInvalido' };
  }
  const { clienteId, semana, reemplazar } = payload.data;
  try {
    const result = await generarPlanSemanal(
      deps,
      asClienteId(clienteId),
      { semana, ...(reemplazar !== undefined ? { reemplazar } : {}) },
      { tipo: 'sistema' },
    );
    log.info({ jobId, clienteId, semana, planId: result.plan.id, piezas: result.piezas.length, resultado: 'plan_creado' }, 'weekly plan job done');
    return { resultado: 'plan_creado', plan_id: result.plan.id };
  } catch (error) {
    if (EXPECTED_ERRORS.some((expected) => error instanceof expected)) {
      const codigo = (error as Error).name;
      log.warn({ jobId, clienteId, semana, resultado: 'rechazado', codigo }, 'weekly plan job rejected');
      return { resultado: 'rechazado', codigo };
    }
    log.error({ jobId, clienteId, semana, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'weekly plan job failed');
    throw error;
  }
}

/** Registers the queue (exclusive, no automatic retries) and its worker. Call after boss.start(). */
export async function registerPlanificadorJobs(boss: PgBoss, deps: PlanificadorDeps): Promise<void> {
  await boss.createQueue(GENERAR_PLAN_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
  await boss.work<GenerarPlanPayload, GenerarPlanOutput>(GENERAR_PLAN_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0]!;
    return ejecutarJobGenerarPlan(deps, job.data, job.id);
  });
}

// ---- The port the routes use, so they can be tested without pg-boss.

export type JobEstado = 'created' | 'active' | 'completed' | 'failed';

export interface JobInfo {
  estado: JobEstado;
  /** The client the job was queued for (from its payload). */
  clienteId: string | null;
  output: unknown;
}

export interface PlanQueue {
  /** Queues a generation. Null when one for the same client and week is already queued or active. */
  enqueue(payload: GenerarPlanPayload): Promise<string | null>;
  getJob(jobId: string): Promise<JobInfo | null>;
}

const ESTADO: Record<string, JobEstado> = { created: 'created', retry: 'created', active: 'active', completed: 'completed', cancelled: 'failed', failed: 'failed' };

export function createPgBossPlanQueue(boss: PgBoss): PlanQueue {
  return {
    enqueue: (payload) => boss.send(GENERAR_PLAN_QUEUE, payload, { singletonKey: singletonKeyFor(payload.clienteId, payload.semana) }),
    async getJob(jobId) {
      const job = await boss.getJobById<{ clienteId?: unknown }>(GENERAR_PLAN_QUEUE, jobId);
      if (!job) return null;
      return {
        estado: ESTADO[job.state] ?? 'failed',
        clienteId: typeof job.data?.clienteId === 'string' ? job.data.clienteId : null,
        output: job.output,
      };
    },
  };
}
