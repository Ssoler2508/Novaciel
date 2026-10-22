import type { Logger } from 'pino';
import { logger as defaultLogger } from '../logger/index.js';
import type { Aviso, Notifier } from './types.js';

/** Test notifier: keeps what it is asked to send. `fallarCon` makes the next sends fail, to test failures. */
export class FakeNotifier implements Notifier {
  readonly enviados: Aviso[] = [];
  fallarCon: Error | null = null;

  async enviar(aviso: Aviso): Promise<void> {
    if (this.fallarCon) throw this.fallarCon;
    this.enviados.push({ ...aviso, referencia: { ...aviso.referencia } });
  }
}

/** Placeholder until a real provider exists (e-mail, SMS, WhatsApp): logs ids and template names only. */
export class LogNotifier implements Notifier {
  constructor(private readonly log: Logger = defaultLogger) {}

  async enviar(aviso: Aviso): Promise<void> {
    this.log.info(
      { clienteId: aviso.clienteId, destinatarioUsuarioId: aviso.destinatarioUsuarioId, plantilla: aviso.plantilla, referencia: aviso.referencia },
      'notice sent (log only)',
    );
  }
}
