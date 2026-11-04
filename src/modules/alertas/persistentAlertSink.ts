import { randomUUID } from 'node:crypto';
import type { Alert, AlertSink } from '../../lib/ai/alerts.js';
import { raiseAlertBestEffort, type AlertasDeps } from './raiseAlert.js';

/**
 * The persistent AlertSink (Step 11): the schema-failure alerts of the language and vision calls become rows
 * of `alertas` (with the Notifier called for NovaCiel). The legacy sink, if given, still logs. The dedupe key
 * embeds the id of the second authorization (`referenceId`), so one failed pair of attempts is one alert.
 */
export class PersistentAlertSink implements AlertSink {
  constructor(
    private readonly deps: AlertasDeps,
    private readonly inner?: AlertSink,
  ) {}

  async alert(alert: Alert): Promise<void> {
    await this.inner?.alert(alert);
    if (alert.code !== 'llm_schema_invalid' && alert.code !== 'vision_schema_invalid') return;
    await raiseAlertBestEffort(this.deps, alert.code, {
      clienteId: alert.clienteId,
      parametros: {
        proposito: alert.purpose,
        proveedor: alert.provider,
        modelo: alert.model,
        intentos: alert.attempts ?? 2,
        // Without a reference id (an old caller) the alert is still stored, just without dedupe.
        referencia_id: alert.referenceId ?? randomUUID(),
      },
    });
  }
}
