import type { Logger } from 'pino';
import { logger as defaultLogger } from '../logger/index.js';

/** Metadata only: never prompts, model outputs or client content. */
export interface Alert {
  code: string;
  clienteId: string;
  purpose: string;
  provider: string;
  model: string;
  attempts?: number;
}

export interface AlertSink {
  alert(alert: Alert): Promise<void>;
}

/** Test sink: keeps the alerts it receives. */
export class FakeAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];

  async alert(alert: Alert): Promise<void> {
    this.alerts.push({ ...alert });
  }
}

/** Placeholder until Step 11 replaces it with the Notifier: logs at error level with metadata. */
export class LogAlertSink implements AlertSink {
  constructor(private readonly log: Logger = defaultLogger) {}

  async alert(alert: Alert): Promise<void> {
    this.log.error({ ...alert }, 'alert raised');
  }
}
