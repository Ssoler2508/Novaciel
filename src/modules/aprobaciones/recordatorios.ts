import { InvalidLocalTimeError } from '../planificador/errors.js';
import { isValidZone, localLabel } from '../planificador/fechas.js';

// Pure. Spec 11.3: reminders 24 h and 4 h before the scheduled time, then the substitute. The hours are
// ELAPSED hours (a US daylight-saving change does not move them); the client's zone is only used to
// report the local date and time of each notice. The substitute's exact time is not in the spec: 2 h
// before by default, configurable (open question in docs/PLAN.md).

export type TipoRecordatorio = 'recordatorio_24h' | 'recordatorio_4h' | 'turno_suplente';

export interface ReglasRecordatorios {
  /** Hours before the deadline of the two reminders to the main approver, in this order. */
  recordatorioLargoHoras: number;
  recordatorioCortoHoras: number;
  /** Hours before the deadline at which the substitute is notified. */
  suplenteHoras: number;
}

export const REGLAS_RECORDATORIOS: ReglasRecordatorios = { recordatorioLargoHoras: 24, recordatorioCortoHoras: 4, suplenteHoras: 2 };

export interface Recordatorio {
  tipo: TipoRecordatorio;
  /** The instant to send it. Always after `ahora` and before the deadline. */
  cuando: Date;
  /** The same instant on the client's wall clock. */
  localFecha: string;
  localHora: string;
}

const HOUR_MS = 60 * 60 * 1000;

/** The notices still to send for `plazo` (the scheduled time), oldest first. Notices already due are dropped. */
export function calcularRecordatorios(
  plazo: Date,
  zonaCliente: string,
  reglas: ReglasRecordatorios,
  ahora: Date,
): Recordatorio[] {
  if (!isValidZone(zonaCliente)) throw new InvalidLocalTimeError('zone');
  const reglasEnOrden: [TipoRecordatorio, number][] = [
    ['recordatorio_24h', reglas.recordatorioLargoHoras],
    ['recordatorio_4h', reglas.recordatorioCortoHoras],
    ['turno_suplente', reglas.suplenteHoras],
  ];
  const result: Recordatorio[] = [];
  for (const [tipo, horas] of reglasEnOrden) {
    const cuando = new Date(plazo.getTime() - horas * HOUR_MS);
    if (cuando.getTime() <= ahora.getTime()) continue;
    const { fecha, hora } = localLabel(cuando, zonaCliente);
    result.push({ tipo, cuando, localFecha: fecha, localHora: hora });
  }
  return result.sort((a, b) => a.cuando.getTime() - b.cuando.getTime());
}
