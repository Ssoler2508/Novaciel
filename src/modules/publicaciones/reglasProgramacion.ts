import { localDateTimeOf } from '../planificador/fechas.js';
import { horarioVetado } from '../planificador/schema.js';
import type { HorarioVetado } from '../planificador/types.js';
import { SinHorarioPermitidoError } from './errors.js';

// Scheduling rules (Step 10, checkpoint B). PURE: the clock comes in as an argument. Vetoed windows are
// local time of the plan's zone; the local date and time of an instant come from Intl (fechas.ts), so the
// US daylight-saving changes are handled. An invalid zone throws InvalidLocalTimeError (programming error).

/** A slot is a quarter of an hour. Every offset of a real zone is a multiple of 15 minutes, so the UTC grid is the local grid. */
export const PASO_MINUTOS = 15;
/** The "no approval at the scheduled time" reschedule goes at least this many ABSOLUTE hours ahead (VERIFY). */
export const MINIMO_HORAS_REPROGRAMACION = 24;
/** How far ahead the search for an allowed slot goes before giving up (VERIFY). */
export const DIAS_MAXIMOS_BUSQUEDA = 14;
/** After this many consecutive automatic reschedules the system stops and raises a critical alert. */
export const LIMITE_REPROGRAMACIONES_AUTOMATICAS = 3;

const PASO_MS = PASO_MINUTOS * 60_000;
const HORA_MS = 60 * 60_000;
const DIA_MS = 24 * HORA_MS;

export type MotivoProgramacion = 'fecha_pasada' | 'horario_vetado';

export type ResultadoProgramacion = { ok: true } | { ok: false; motivos: readonly MotivoProgramacion[] };

export interface EntradaValidarProgramacion {
  fechaHora: Date;
  ahora: Date;
  /** `planes_semanales.zona_horaria`. */
  zona: string;
  horariosVetados: readonly HorarioVetado[];
}

/** A hard rule: the time is in the future and outside the vetoed hours. (Being too close is only a QC warning.) */
export function validarProgramacion(e: EntradaValidarProgramacion): ResultadoProgramacion {
  const motivos: MotivoProgramacion[] = [];
  const { fecha, hora } = localDateTimeOf(e.fechaHora, e.zona);
  if (e.fechaHora.getTime() <= e.ahora.getTime()) motivos.push('fecha_pasada');
  if (horarioVetado(e.horariosVetados, fecha, hora)) motivos.push('horario_vetado');
  return motivos.length === 0 ? { ok: true } : { ok: false, motivos };
}

export interface EntradaSiguienteHorario {
  /** The instant the search starts from (normally "now" or the missed `fecha_hora`). */
  desde: Date;
  zona: string;
  horariosVetados: readonly HorarioVetado[];
  /** Absolute hours (UTC) added to `desde` before looking for a slot. Default 24. */
  minimoHoras?: number;
}

/**
 * The first allowed 15-minute slot at or after `desde + minimoHoras` absolute hours. The 24 hours are
 * elapsed time, not "the same wall clock tomorrow", so a DST change inside them shifts the local time.
 * Throws SinHorarioPermitidoError when no slot is free within DIAS_MAXIMOS_BUSQUEDA days.
 */
export function siguienteHorarioPermitido(e: EntradaSiguienteHorario): Date {
  const minimo = (e.minimoHoras ?? MINIMO_HORAS_REPROGRAMACION) * HORA_MS;
  const base = e.desde.getTime() + minimo;
  const inicio = Math.ceil(base / PASO_MS) * PASO_MS;
  const fin = base + DIAS_MAXIMOS_BUSQUEDA * DIA_MS;
  for (let ms = inicio; ms <= fin; ms += PASO_MS) {
    const instante = new Date(ms);
    const { fecha, hora } = localDateTimeOf(instante, e.zona);
    if (!horarioVetado(e.horariosVetados, fecha, hora)) return instante;
  }
  throw new SinHorarioPermitidoError(DIAS_MAXIMOS_BUSQUEDA);
}

/** True while the automatic "no approval" reschedules in a row are below the limit. */
export function puedeReprogramarAutomaticamente(reprogramacionesConsecutivas: number): boolean {
  return reprogramacionesConsecutivas < LIMITE_REPROGRAMACIONES_AUTOMATICAS;
}
