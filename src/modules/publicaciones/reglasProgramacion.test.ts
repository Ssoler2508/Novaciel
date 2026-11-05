import { describe, expect, it } from 'vitest';
import { InvalidLocalTimeError } from '../planificador/errors.js';
import type { HorarioVetado } from '../planificador/types.js';
import { SinHorarioPermitidoError } from './errors.js';
import {
  DIAS_MAXIMOS_BUSQUEDA,
  LIMITE_REPROGRAMACIONES_AUTOMATICAS,
  puedeReprogramarAutomaticamente,
  siguienteHorarioPermitido,
  validarProgramacion,
} from './reglasProgramacion.js';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const SIN_VETOS: HorarioVetado[] = [];
const iso = (d: Date) => d.toISOString();

describe('validarProgramacion', () => {
  const ahora = new Date('2026-06-10T12:00:00Z');

  it('accepts a future time outside the vetoed hours', () => {
    expect(validarProgramacion({ fechaHora: new Date('2026-06-10T15:00:00Z'), ahora, zona: NY, horariosVetados: SIN_VETOS })).toEqual({ ok: true });
  });

  it('rejects now and the past, but accepts one millisecond ahead', () => {
    const r = (ms: number) => validarProgramacion({ fechaHora: new Date(ahora.getTime() + ms), ahora, zona: NY, horariosVetados: SIN_VETOS });
    expect(r(0)).toEqual({ ok: false, motivos: ['fecha_pasada'] });
    expect(r(-60_000)).toEqual({ ok: false, motivos: ['fecha_pasada'] });
    expect(r(1)).toEqual({ ok: true });
  });

  it('rejects a vetoed window in the CLIENT zone, end exclusive', () => {
    const vetos: HorarioVetado[] = [{ desde: '22:00', hasta: '23:00' }];
    const r = (utc: string) => validarProgramacion({ fechaHora: new Date(utc), ahora, zona: NY, horariosVetados: vetos });
    // 22:00 EDT = 02:00Z next day
    expect(r('2026-06-11T02:00:00Z')).toEqual({ ok: false, motivos: ['horario_vetado'] });
    expect(r('2026-06-11T02:59:00Z')).toEqual({ ok: false, motivos: ['horario_vetado'] });
    expect(r('2026-06-11T03:00:00Z')).toEqual({ ok: true });
    // The same UTC hour as a veto in UTC terms is fine in the client zone.
    expect(r('2026-06-10T22:00:00Z')).toEqual({ ok: true });
  });

  it('applies a veto with a day only to that day of the week (local)', () => {
    const vetos: HorarioVetado[] = [{ dia: 'lunes', desde: '09:00', hasta: '12:00' }];
    const r = (utc: string) => validarProgramacion({ fechaHora: new Date(utc), ahora, zona: NY, horariosVetados: vetos });
    expect(r('2026-06-15T14:00:00Z')).toEqual({ ok: false, motivos: ['horario_vetado'] }); // Monday 10:00 EDT
    expect(r('2026-06-16T14:00:00Z')).toEqual({ ok: true }); // Tuesday
  });

  it('reports both reasons together', () => {
    const vetos: HorarioVetado[] = [{ desde: '00:00', hasta: '23:59' }];
    expect(validarProgramacion({ fechaHora: new Date('2026-06-09T12:00:00Z'), ahora, zona: NY, horariosVetados: vetos })).toEqual({
      ok: false,
      motivos: ['fecha_pasada', 'horario_vetado'],
    });
  });

  it('reads the local time across the spring-forward change (same UTC hour, different local hour)', () => {
    const vetos: HorarioVetado[] = [{ desde: '07:00', hasta: '08:00' }];
    const ahoraMarzo = new Date('2026-03-01T00:00:00Z');
    const r = (utc: string) => validarProgramacion({ fechaHora: new Date(utc), ahora: ahoraMarzo, zona: NY, horariosVetados: vetos });
    expect(r('2026-03-07T12:00:00Z')).toEqual({ ok: false, motivos: ['horario_vetado'] }); // 07:00 EST
    expect(r('2026-03-09T12:00:00Z')).toEqual({ ok: true }); // 08:00 EDT
    expect(r('2026-03-09T11:00:00Z')).toEqual({ ok: false, motivos: ['horario_vetado'] }); // 07:00 EDT
  });

  it('reads the local time across the fall-back change, including the hour that happens twice', () => {
    const vetos: HorarioVetado[] = [{ desde: '01:00', hasta: '02:00' }];
    const ahoraOtono = new Date('2026-10-01T00:00:00Z');
    const r = (utc: string) => validarProgramacion({ fechaHora: new Date(utc), ahora: ahoraOtono, zona: NY, horariosVetados: vetos });
    expect(r('2026-11-01T05:30:00Z')).toEqual({ ok: false, motivos: ['horario_vetado'] }); // 01:30 EDT
    expect(r('2026-11-01T06:30:00Z')).toEqual({ ok: false, motivos: ['horario_vetado'] }); // 01:30 EST (second time)
    expect(r('2026-11-01T07:00:00Z')).toEqual({ ok: true }); // 02:00 EST
  });

  it('throws on an invalid zone (a programming error)', () => {
    expect(() => validarProgramacion({ fechaHora: new Date('2026-06-10T15:00:00Z'), ahora, zona: 'Nowhere/Land', horariosVetados: SIN_VETOS })).toThrow(InvalidLocalTimeError);
  });
});

describe('siguienteHorarioPermitido', () => {
  it('is exactly 24 absolute hours ahead when the slot is free, rounded up to the 15-minute grid', () => {
    expect(iso(siguienteHorarioPermitido({ desde: new Date('2026-06-10T12:00:00Z'), zona: NY, horariosVetados: SIN_VETOS }))).toBe('2026-06-11T12:00:00.000Z');
    expect(iso(siguienteHorarioPermitido({ desde: new Date('2026-06-10T12:00:01Z'), zona: NY, horariosVetados: SIN_VETOS }))).toBe('2026-06-11T12:15:00.000Z');
    expect(iso(siguienteHorarioPermitido({ desde: new Date('2026-06-10T12:07:00Z'), zona: NY, horariosVetados: SIN_VETOS }))).toBe('2026-06-11T12:15:00.000Z');
    expect(iso(siguienteHorarioPermitido({ desde: new Date('2026-06-10T12:15:00Z'), zona: NY, horariosVetados: SIN_VETOS }))).toBe('2026-06-11T12:15:00.000Z');
  });

  it('skips a vetoed window and lands on its (exclusive) end, in the client zone', () => {
    const vetos: HorarioVetado[] = [{ dia: 'lunes', desde: '09:00', hasta: '12:00' }];
    // 24 h after Sunday 10:00 EDT is Monday 10:00 EDT = 14:00Z, vetoed; the window ends at 12:00 EDT = 16:00Z.
    const r = siguienteHorarioPermitido({ desde: new Date('2026-06-14T14:00:00Z'), zona: NY, horariosVetados: vetos });
    expect(iso(r)).toBe('2026-06-15T16:00:00.000Z');
  });

  it('crosses midnight and a vetoed day', () => {
    const vetos: HorarioVetado[] = [{ dia: 'martes', desde: '00:00', hasta: '23:59' }, { dia: 'miercoles', desde: '00:00', hasta: '06:00' }];
    // Base: Tuesday 2026-06-16 08:00 EDT. Tuesday is vetoed until its last minute (23:45 is still inside); Wednesday until 06:00.
    const r = siguienteHorarioPermitido({ desde: new Date('2026-06-15T12:00:00Z'), zona: NY, horariosVetados: vetos });
    expect(iso(r)).toBe('2026-06-17T10:00:00.000Z'); // Wednesday 06:00 EDT
  });

  it('the +24 h crossing the spring-forward change is elapsed time, not the same wall clock', () => {
    // Sat 2026-03-07 23:30 EST = 04:30Z on the 8th. DST starts on the 8th at 02:00. +24 h = 04:30Z on the 9th = 00:30 EDT.
    const desde = new Date('2026-03-08T04:30:00Z');
    expect(iso(siguienteHorarioPermitido({ desde, zona: NY, horariosVetados: SIN_VETOS }))).toBe('2026-03-09T04:30:00.000Z');
    // The wall clock "23:30 the next day" would have been 03:30Z: it is NOT what is returned.
    const vetos: HorarioVetado[] = [{ desde: '00:00', hasta: '01:00' }];
    expect(iso(siguienteHorarioPermitido({ desde, zona: NY, horariosVetados: vetos }))).toBe('2026-03-09T05:00:00.000Z'); // 01:00 EDT
  });

  it('the +24 h crossing the fall-back change lands on the second occurrence of the repeated hour', () => {
    // Sat 2026-10-31 02:30 EDT = 06:30Z. +24 h = 2026-11-01 06:30Z = 01:30 EST (the repeated hour, second time).
    const desde = new Date('2026-10-31T06:30:00Z');
    expect(iso(siguienteHorarioPermitido({ desde, zona: NY, horariosVetados: SIN_VETOS }))).toBe('2026-11-01T06:30:00.000Z');
    const vetos: HorarioVetado[] = [{ desde: '01:00', hasta: '02:00' }];
    expect(iso(siguienteHorarioPermitido({ desde, zona: NY, horariosVetados: vetos }))).toBe('2026-11-01T07:00:00.000Z'); // 02:00 EST
  });

  it('never returns a time that does not exist: a veto ending in the spring-forward gap lands after the gap', () => {
    // Base 2026-03-08 06:00Z = 01:00 EST. Vetoed 01:00-03:00 (the local hour 02:xx does not exist that day).
    const vetos: HorarioVetado[] = [{ desde: '01:00', hasta: '03:00' }];
    const r = siguienteHorarioPermitido({ desde: new Date('2026-03-07T06:00:00Z'), zona: NY, horariosVetados: vetos });
    expect(iso(r)).toBe('2026-03-08T07:00:00.000Z'); // 03:00 EDT
  });

  it('works in the Pacific zone and in a zone with a 30-minute offset', () => {
    const vetos: HorarioVetado[] = [{ desde: '10:00', hasta: '11:00' }];
    // 2026-06-10 17:00Z = 10:00 PDT. +24 h = 10:00 PDT next day, vetoed until 11:00 PDT = 18:00Z.
    expect(iso(siguienteHorarioPermitido({ desde: new Date('2026-06-09T17:00:00Z'), zona: LA, horariosVetados: vetos }))).toBe('2026-06-10T18:00:00.000Z');
    // Asia/Kolkata is UTC+5:30: 04:30Z = 10:00 IST.
    expect(iso(siguienteHorarioPermitido({ desde: new Date('2026-06-09T04:30:00Z'), zona: 'Asia/Kolkata', horariosVetados: vetos }))).toBe('2026-06-10T05:30:00.000Z');
  });

  it('honours a custom minimum', () => {
    expect(iso(siguienteHorarioPermitido({ desde: new Date('2026-06-10T12:00:00Z'), zona: NY, horariosVetados: SIN_VETOS, minimoHoras: 2 }))).toBe('2026-06-10T14:00:00.000Z');
  });

  it('throws SinHorarioPermitidoError when every slot of the window is vetoed', () => {
    const vetos: HorarioVetado[] = [{ desde: '00:00', hasta: '23:59' }];
    const call = () => siguienteHorarioPermitido({ desde: new Date('2026-06-10T12:00:00Z'), zona: NY, horariosVetados: vetos });
    expect(call).toThrow(SinHorarioPermitidoError);
    try {
      call();
    } catch (e) {
      expect((e as SinHorarioPermitidoError).diasBuscados).toBe(DIAS_MAXIMOS_BUSQUEDA);
    }
  });

  it('finds a slot after six fully vetoed days', () => {
    // Vetoed every day except Sundays: from Monday 2026-06-15 the next free day is Sunday the 21st.
    const vetos: HorarioVetado[] = (['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const).map((dia) => ({ dia, desde: '00:00', hasta: '23:59' }));
    const r = siguienteHorarioPermitido({ desde: new Date('2026-06-14T04:00:00Z'), zona: NY, horariosVetados: vetos });
    expect(iso(r)).toBe('2026-06-21T04:00:00.000Z'); // base 06-15 00:00 EDT is Monday and vetoed ... until Sunday 00:00 EDT
  });

  it('throws on an invalid zone', () => {
    expect(() => siguienteHorarioPermitido({ desde: new Date('2026-06-10T12:00:00Z'), zona: 'bad', horariosVetados: SIN_VETOS })).toThrow(InvalidLocalTimeError);
  });
});

describe('puedeReprogramarAutomaticamente', () => {
  it('allows below the limit and stops at it', () => {
    expect(LIMITE_REPROGRAMACIONES_AUTOMATICAS).toBe(3);
    expect(puedeReprogramarAutomaticamente(0)).toBe(true);
    expect(puedeReprogramarAutomaticamente(2)).toBe(true);
    expect(puedeReprogramarAutomaticamente(3)).toBe(false);
    expect(puedeReprogramarAutomaticamente(4)).toBe(false);
  });
});
