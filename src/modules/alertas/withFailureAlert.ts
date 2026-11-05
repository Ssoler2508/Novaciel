import type { Job } from 'pg-boss';
import { raiseAlertBestEffort, type AlertasDeps } from './raiseAlert.js';

const SAFE_NAME = /^[A-Za-z0-9_.:/-]{1,100}$/;

/**
 * Wraps a pg-boss handler: when it throws, raises `trabajo_fallido` (queue name, job id and the error NAME
 * only: never the payload or the message) and throws the same error again, so pg-boss still marks the job as
 * failed. A handler that returns normally, also with a "rechazado" result, is not a failure. Without `alertas`
 * it returns the handler untouched.
 */
export function withFailureAlert<J, R>(
  alertas: AlertasDeps | undefined,
  cola: string,
  handler: (jobs: Job<J>[]) => Promise<R>,
): (jobs: Job<J>[]) => Promise<R> {
  if (!alertas) return handler;
  return async (jobs) => {
    try {
      return await handler(jobs);
    } catch (error) {
      const nombre = error instanceof Error && SAFE_NAME.test(error.name) ? error.name : 'UnknownError';
      for (const job of jobs) {
        await raiseAlertBestEffort(alertas, 'trabajo_fallido', { clienteId: null, parametros: { cola, job_id: job.id, nombre_error: nombre } });
      }
      throw error;
    }
  };
}
