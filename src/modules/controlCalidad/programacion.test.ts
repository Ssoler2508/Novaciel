import { describe, expect, it } from 'vitest';
import { InvalidLocalTimeError } from '../planificador/errors.js';
import { horarioVetado } from '../planificador/schema.js';
import type { HorarioVetado } from '../planificador/types.js';
import { checksProgramacion, MINUTOS_PROXIMA } from './programacion.js';
import type { CheckQC } from './tipos.js';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const ahora = new Date('2026-02-01T00:00:00Z');
const MIN = 60_000;

const por = (checks: CheckQC[], codigo: string) => checks.find((c) => c.codigo === codigo)!;
const vetado = (instante: string, zona: string, horarios: HorarioVetado[]) =>
  por(checksProgramacion({ fechaHora: new Date(instante), ahora, zona, horariosVetados: horarios }), 'horario_vetado').resultado === 'no_pasa';

describe('checksProgramacion: the future', () => {
  const base = new Date('2026-06-10T15:00:00Z');
  const checar = (fechaHora: Date) => checksProgramacion({ fechaHora, ahora: base, zona: NY, horariosVetados: [] });

  it('returns the three codes and all pass for a publication well in the future', () => {
    const checks = checar(new Date(base.getTime() + 3 * 60 * MIN));
    expect(checks.map((c) => [c.codigo, c.resultado])).toEqual([
      ['fecha_pasada', 'pasa'],
      ['horario_vetado', 'pasa'],
      ['programacion_proxima', 'pasa'],
    ]);
  });

  it('refuses a date in the past and a date right now, and does not also warn about being close', () => {
    for (const desplazo of [-60 * MIN, -1, 0]) {
      const checks = checar(new Date(base.getTime() + desplazo));
      expect(por(checks, 'fecha_pasada').resultado, String(desplazo)).toBe('no_pasa');
      expect(por(checks, 'programacion_proxima').resultado, String(desplazo)).toBe('pasa');
    }
    expect(por(checar(new Date(base.getTime() + 1)), 'fecha_pasada').resultado).toBe('pasa');
  });

  it('warns, without rejecting, when the publication is closer than 30 minutes', () => {
    const cerca = por(checar(new Date(base.getTime() + 10 * MIN)), 'programacion_proxima');
    expect(cerca).toMatchObject({ resultado: 'advertencia', severidad: 'advertencia', parametros: { minutos_restantes: 10 } });
    expect(por(checar(new Date(base.getTime() + MINUTOS_PROXIMA * MIN - 1)), 'programacion_proxima').resultado).toBe('advertencia');
    expect(por(checar(new Date(base.getTime() + MINUTOS_PROXIMA * MIN)), 'programacion_proxima').resultado).toBe('pasa');
  });
});

describe('checksProgramacion: vetoed hours in the zone of the plan', () => {
  it('a window of a weekday: start inclusive, end exclusive, other days free', () => {
    // 2026-10-12 is a Monday; New York is on daylight time (UTC-4).
    const lunes: HorarioVetado[] = [{ dia: 'lunes', desde: '09:00', hasta: '12:00' }];
    expect(vetado('2026-10-12T13:00:00Z', NY, lunes)).toBe(true); // 09:00
    expect(vetado('2026-10-12T14:00:00Z', NY, lunes)).toBe(true); // 10:00
    expect(vetado('2026-10-12T15:59:00Z', NY, lunes)).toBe(true); // 11:59
    expect(vetado('2026-10-12T16:00:00Z', NY, lunes)).toBe(false); // 12:00, end exclusive
    expect(vetado('2026-10-12T12:59:00Z', NY, lunes)).toBe(false); // 08:59
    expect(vetado('2026-10-13T14:00:00Z', NY, lunes)).toBe(false); // Tuesday 10:00
  });

  it('a window with no weekday applies every day', () => {
    const todos: HorarioVetado[] = [{ desde: '00:00', hasta: '06:00' }];
    expect(vetado('2026-10-12T08:00:00Z', NY, todos)).toBe(true); // 04:00 Monday
    expect(vetado('2026-10-14T08:00:00Z', NY, todos)).toBe(true); // 04:00 Wednesday
    expect(vetado('2026-10-14T10:00:00Z', NY, todos)).toBe(false); // 06:00
  });

  it('reads the weekday in the local zone, not in UTC', () => {
    // 2026-11-02T03:30Z is Monday in UTC but Sunday 22:30 in New York.
    const instante = '2026-11-02T03:30:00Z';
    expect(vetado(instante, NY, [{ dia: 'domingo', desde: '22:00', hasta: '23:00' }])).toBe(true);
    expect(vetado(instante, NY, [{ dia: 'lunes', desde: '22:00', hasta: '23:00' }])).toBe(false);
    expect(vetado(instante, 'UTC', [{ dia: 'lunes', desde: '03:00', hasta: '04:00' }])).toBe(true);
  });

  describe('US daylight saving', () => {
    it('spring forward in New York (2026-03-08): 06:59Z is 01:59 and 07:00Z is already 03:00', () => {
      const antes: HorarioVetado[] = [{ desde: '01:00', hasta: '02:00' }];
      expect(vetado('2026-03-08T06:59:00Z', NY, antes)).toBe(true);
      expect(vetado('2026-03-08T07:00:00Z', NY, antes)).toBe(false);
      // The hour from 02:00 to 03:00 does not exist that day: no instant falls in it.
      const hueco: HorarioVetado[] = [{ desde: '02:00', hasta: '03:00' }];
      expect(vetado('2026-03-08T06:59:00Z', NY, hueco)).toBe(false);
      expect(vetado('2026-03-08T07:00:00Z', NY, hueco)).toBe(false);
      // The day before, the same window does apply at 02:30 local.
      expect(vetado('2026-03-07T07:30:00Z', NY, hueco)).toBe(true);
    });

    it('fall back in New York (2026-11-01): 01:30 happens twice and 07:00Z is 02:00', () => {
      const ventana: HorarioVetado[] = [{ desde: '01:00', hasta: '02:00' }];
      expect(vetado('2026-11-01T05:30:00Z', NY, ventana)).toBe(true); // 01:30 EDT, first time
      expect(vetado('2026-11-01T06:30:00Z', NY, ventana)).toBe(true); // 01:30 EST, second time
      expect(vetado('2026-11-01T06:59:00Z', NY, ventana)).toBe(true); // 01:59 EST
      expect(vetado('2026-11-01T07:00:00Z', NY, ventana)).toBe(false); // 02:00 EST
      expect(vetado('2026-11-01T04:59:00Z', NY, ventana)).toBe(false); // 00:59 EDT
    });

    it('spring forward in Los Angeles (2026-03-08): 09:59Z is 01:59 and 10:00Z is 03:00', () => {
      const ventana: HorarioVetado[] = [{ desde: '01:00', hasta: '02:00' }];
      expect(vetado('2026-03-08T09:59:00Z', LA, ventana)).toBe(true);
      expect(vetado('2026-03-08T10:00:00Z', LA, ventana)).toBe(false);
      expect(vetado('2026-03-08T10:00:00Z', LA, [{ desde: '03:00', hasta: '04:00' }])).toBe(true);
    });

    it('fall back in Los Angeles (2026-11-01): 01:30 happens twice and 10:00Z is 02:00', () => {
      const ventana: HorarioVetado[] = [{ desde: '01:00', hasta: '02:00' }];
      expect(vetado('2026-11-01T08:30:00Z', LA, ventana)).toBe(true); // 01:30 PDT
      expect(vetado('2026-11-01T09:30:00Z', LA, ventana)).toBe(true); // 01:30 PST
      expect(vetado('2026-11-01T10:00:00Z', LA, ventana)).toBe(false); // 02:00 PST
    });

    it('a zone without daylight saving never shifts', () => {
      const ventana: HorarioVetado[] = [{ desde: '01:00', hasta: '02:00' }];
      // Bogota is always UTC-5: 01:30 local is 06:30Z on the day the US changes and on the day after.
      expect(vetado('2026-03-08T06:30:00Z', 'America/Bogota', ventana)).toBe(true);
      expect(vetado('2026-03-09T06:30:00Z', 'America/Bogota', ventana)).toBe(true);
      expect(vetado('2026-03-08T07:30:00Z', 'America/Bogota', ventana)).toBe(false); // 02:30
    });
  });

  it('parameters carry the weekday and the local minute, never the windows', () => {
    const checks = checksProgramacion({
      fechaHora: new Date('2026-10-12T14:00:00Z'),
      ahora,
      zona: NY,
      horariosVetados: [{ dia: 'lunes', desde: '09:00', hasta: '12:00' }],
    });
    expect(por(checks, 'horario_vetado')).toMatchObject({ resultado: 'no_pasa', parametros: { dia: 'lunes', minuto_local: 600 } });
  });

  it('an invalid zone is a programming error, not a failed piece', () => {
    expect(() => checksProgramacion({ fechaHora: new Date('2026-10-12T14:00:00Z'), ahora, zona: 'Marte/Olimpo', horariosVetados: [] })).toThrow(InvalidLocalTimeError);
  });
});

describe('horarioVetado (shared with the planner)', () => {
  it('matches a weekday window and a window for every day', () => {
    expect(horarioVetado([{ dia: 'lunes', desde: '09:00', hasta: '10:00' }], '2026-10-12', '09:30')).toBe(true);
    expect(horarioVetado([{ dia: 'lunes', desde: '09:00', hasta: '10:00' }], '2026-10-13', '09:30')).toBe(false);
    expect(horarioVetado([{ desde: '09:00', hasta: '10:00' }], '2026-10-13', '10:00')).toBe(false);
    expect(horarioVetado([], '2026-10-13', '10:00')).toBe(false);
  });
});
