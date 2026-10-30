import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { PiezaNotFoundError } from '../piezas/errors.js';
import { PlanNoAprobadoError } from '../planificador/errors.js';
import type { ControlCalidadEncolador } from '../produccion/produccionService.js';
import { getProduccionActual } from '../produccion/produccionRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import { ejecutarQC, type QcDeps } from './ejecutarQC.js';
import { QcEstadoInvalidoError, QcProduccionCambioError, QcSinProduccionError } from './errors.js';

// The quality-control job (Step 8). It is queued by the final transaction of a production, so QC starts
// by itself, and by the NovaCiel re-run route. A domain refusal ends the job normally ("rechazado");
// anything else (a storage outage, a missing ffprobe, inconsistent data) FAILS the job loudly. Jobs are
// never retried: a QC that REJECTS the piece is a normal result, not a failure. Logs and outputs carry
// ids, codes and error names only: never text of the client.

export const CONTROL_CALIDAD_QUEUE = 'control-calidad';

const payloadSchema = z.object({ clienteId: z.uuid(), piezaId: z.uuid(), produccionId: z.uuid() }).strict();
export type ControlCalidadPayload = z.infer<typeof payloadSchema>;

/** What the job leaves behind. */
export interface ControlCalidadOutput {
  resultado: 'control_realizado' | 'rechazado';
  /** The error name, when the job was refused. */
  codigo?: string;
  revision_id?: string;
  /** The result of the QC itself: approved or rejected. */
  qc?: 'aprobado' | 'rechazado';
  codigos_fallo?: string[];
}

/** One job per production: the same production is never queued twice while one is queued or active. */
export const singletonKeyControlCalidad = (clienteId: string, produccionId: string) => `${clienteId}:${produccionId}`;

const EXPECTED_ERRORS = [PiezaNotFoundError, PlanNoAprobadoError, QcEstadoInvalidoError, QcSinProduccionError, QcProduccionCambioError] as const;
const errorName = (error: unknown) => (error instanceof Error ? error.name : 'UnknownError');

/** Runs one QC job. Pure of pg-boss, so tests can call it directly. */
export async function ejecutarJobControlCalidad(deps: QcDeps, data: unknown, jobId?: string): Promise<ControlCalidadOutput> {
  const log = deps.logger ?? defaultLogger;
  const payload = payloadSchema.safeParse(data);
  if (!payload.success) {
    log.warn({ jobId, resultado: 'rechazado', codigo: 'PayloadInvalido' }, 'quality control job rejected');
    return { resultado: 'rechazado', codigo: 'PayloadInvalido' };
  }
  const { clienteId, piezaId, produccionId } = payload.data;
  try {
    const cliente = asClienteId(clienteId);
    // A job of a production that was replaced meanwhile has nothing to control: the new one has its own job.
    const actual = await getProduccionActual(deps.db, cliente, piezaId);
    if (actual && actual.id !== produccionId) throw new QcProduccionCambioError(produccionId);
    const { revision } = await ejecutarQC(deps, cliente, piezaId, { tipo: 'sistema' });
    return { resultado: 'control_realizado', revision_id: revision.id, qc: revision.resultado, codigos_fallo: [...revision.codigos_fallo] };
  } catch (error) {
    if (EXPECTED_ERRORS.some((expected) => error instanceof expected)) {
      const codigo = errorName(error);
      log.warn({ jobId, clienteId, piezaId, resultado: 'rechazado', codigo }, 'quality control job rejected');
      return { resultado: 'rechazado', codigo };
    }
    log.error({ jobId, clienteId, piezaId, errorName: errorName(error) }, 'quality control job failed');
    throw error;
  }
}

/** Creates the queue (idempotent). The server, the scripts and the tests all call it, so a job can be queued before a worker exists. */
export async function crearColaControlCalidad(boss: PgBoss): Promise<void> {
  await boss.createQueue(CONTROL_CALIDAD_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
}

/** Creates the queue and its worker. Call after boss.start(). */
export async function registerControlCalidadJobs(boss: PgBoss, deps: QcDeps): Promise<void> {
  await crearColaControlCalidad(boss);
  await boss.work<ControlCalidadPayload, ControlCalidadOutput>(CONTROL_CALIDAD_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0]!;
    return ejecutarJobControlCalidad(deps, job.data, job.id);
  });
}

// ---- The ports.

const enTransaccion = (tx: Db) => ({ executeSql: async (text: string, values?: unknown[]) => ({ rows: (await tx.query(text, values as never[])).rows }) });

/** The port the production service uses: queues inside ITS transaction. */
export function createPgBossControlCalidad(boss: PgBoss): ControlCalidadEncolador {
  return {
    async encolar(tx, input) {
      await boss.send(CONTROL_CALIDAD_QUEUE, input satisfies ControlCalidadPayload, {
        singletonKey: singletonKeyControlCalidad(input.clienteId, input.produccionId),
        db: enTransaccion(tx),
      });
    },
  };
}

/** The port the re-run route uses. */
export interface ControlCalidadQueue {
  /** Queues a run. Null when one for the same production is already queued or active. */
  enqueue(payload: ControlCalidadPayload): Promise<string | null>;
}

export function createPgBossControlCalidadQueue(boss: PgBoss): ControlCalidadQueue {
  return {
    enqueue: (payload) => boss.send(CONTROL_CALIDAD_QUEUE, payload, { singletonKey: singletonKeyControlCalidad(payload.clienteId, payload.produccionId) }),
  };
}
