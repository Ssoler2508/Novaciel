import { diaDeLaSemana, localDateTimeOf, minutesOf } from '../planificador/fechas.js';
import { horarioVetado } from '../planificador/schema.js';
import type { HorarioVetado } from '../planificador/types.js';
import { crearCheck } from './crearCheck.js';
import type { CheckQC } from './tipos.js';

// Schedule: the piece is published in the future, outside the client's vetoed hours. The vetoed windows
// are local time of the plan's zone; the local date and time of the instant come from Intl, so the US
// daylight-saving changes are handled (the hour that does not exist cannot be an instant, and the hour
// that happens twice reads the same local time both times).

/** A publication closer than this gets a warning: the reviewers may not have time. House value. */
export const MINUTOS_PROXIMA = 30;

export interface EntradaProgramacion {
  fechaHora: Date;
  ahora: Date;
  /** `planes_semanales.zona_horaria`. An invalid zone throws `InvalidLocalTimeError` (a programming error). */
  zona: string;
  horariosVetados: readonly HorarioVetado[];
}

export function checksProgramacion(e: EntradaProgramacion): CheckQC[] {
  const restanteMs = e.fechaHora.getTime() - e.ahora.getTime();
  const minutosRestantes = Math.floor(restanteMs / 60_000);
  const { fecha, hora } = localDateTimeOf(e.fechaHora, e.zona);

  return [
    crearCheck('fecha_pasada', restanteMs > 0, { minutos_restantes: minutosRestantes }),
    crearCheck('horario_vetado', !horarioVetado(e.horariosVetados, fecha, hora), { dia: diaDeLaSemana(fecha), minuto_local: minutesOf(hora) }),
    crearCheck('programacion_proxima', !(restanteMs > 0 && restanteMs < MINUTOS_PROXIMA * 60_000), { minutos_restantes: minutosRestantes }),
  ];
}
