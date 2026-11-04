import { logger as defaultLogger } from '../../lib/logger/index.js';
import { getSpendSummary } from '../presupuesto/presupuestoService.js';
import type { ClienteId } from '../shared/clienteId.js';
import { raiseAlert, type AlertasRuntime } from './raiseAlert.js';

/**
 * Raises the budget alerts a client has reached this month (50, 80 and 100 % of the ceiling, per config).
 * Call it right after a paid call has been settled and committed. Each threshold alert exists once per
 * client and month (the dedupe key), so calling it after every cost is cheap and safe. Without `runtime`
 * (tests and scripts that do not wire alerts) it does nothing; a failure is logged by name and never thrown,
 * so it cannot break the paid work that triggered it.
 */
export async function evaluarUmbrales(runtime: AlertasRuntime | undefined, clienteId: ClienteId): Promise<void> {
  if (!runtime) return;
  try {
    const resumen = await getSpendSummary(runtime.db, clienteId);
    if (resumen.percentUsed === null) return;
    for (const umbral of runtime.umbrales) {
      if (resumen.percentUsed < umbral) continue;
      await raiseAlert(runtime, `presupuesto_umbral_${umbral}` as 'presupuesto_umbral_50', {
        clienteId,
        parametros: { periodo: resumen.periodo, umbral, porcentaje: resumen.percentUsed },
      });
    }
  } catch (error) {
    (runtime.logger ?? defaultLogger).error({ clienteId, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'budget thresholds could not be evaluated');
  }
}
