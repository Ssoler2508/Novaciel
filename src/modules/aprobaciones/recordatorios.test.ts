import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidLocalTimeError } from '../planificador/errors.js';
import { calcularRecordatorios, REGLAS_RECORDATORIOS } from './recordatorios.js';

const H = 3_600_000;
const plazo = new Date('2026-12-10T15:00:00Z'); // 10:00 in New York (EST, UTC-5)
const NY = 'America/New_York';
const tipos = (xs: { tipo: string }[]) => xs.map((x) => x.tipo);

describe('calcularRecordatorios', () => {
  it('gives the 24 h, 4 h and substitute notices (2 h by default), in order, with the client local time', () => {
    const out = calcularRecordatorios(plazo, NY, REGLAS_RECORDATORIOS, new Date(plazo.getTime() - 48 * H));
    expect(out.map((x) => [x.tipo, x.cuando.toISOString(), x.localFecha, x.localHora])).toEqual([
      ['recordatorio_24h', '2026-12-09T15:00:00.000Z', '2026-12-09', '10:00'],
      ['recordatorio_4h', '2026-12-10T11:00:00.000Z', '2026-12-10', '06:00'],
      ['turno_suplente', '2026-12-10T13:00:00.000Z', '2026-12-10', '08:00'],
    ]);
  });

  it('drops the notices that are already due: a deadline too close for one or more', () => {
    const at = (hoursBefore: number) => calcularRecordatorios(plazo, NY, REGLAS_RECORDATORIOS, new Date(plazo.getTime() - hoursBefore * H));
    expect(tipos(at(30))).toEqual(['recordatorio_24h', 'recordatorio_4h', 'turno_suplente']);
    expect(tipos(at(10))).toEqual(['recordatorio_4h', 'turno_suplente']);
    expect(tipos(at(3))).toEqual(['turno_suplente']);
    expect(at(1)).toEqual([]);
    expect(at(0)).toEqual([]);
    expect(at(-5)).toEqual([]); // the deadline has passed
  });

  it('a notice exactly at "now" is already due; one millisecond earlier it is not', () => {
    const exactly = new Date(plazo.getTime() - 4 * H);
    expect(tipos(calcularRecordatorios(plazo, NY, REGLAS_RECORDATORIOS, exactly))).toEqual(['turno_suplente']);
    expect(tipos(calcularRecordatorios(plazo, NY, REGLAS_RECORDATORIOS, new Date(exactly.getTime() - 1)))).toEqual(['recordatorio_4h', 'turno_suplente']);
  });

  it('uses elapsed hours across the US spring-forward day: the instants do not move, the local labels do', () => {
    const spring = new Date('2027-03-14T14:00:00Z'); // 10:00 EDT on the day clocks jumped at 02:00
    const out = calcularRecordatorios(spring, NY, REGLAS_RECORDATORIOS, new Date(spring.getTime() - 48 * H));
    expect(out.map((x) => spring.getTime() - x.cuando.getTime())).toEqual([24 * H, 4 * H, 2 * H]);
    expect(out[0]).toMatchObject({ localFecha: '2027-03-13', localHora: '09:00' }); // 24 h earlier is 09:00 local, not 10:00
    expect(out[1]).toMatchObject({ localFecha: '2027-03-14', localHora: '06:00' });
  });

  it('uses elapsed hours across the US fall-back day', () => {
    const fall = new Date('2026-11-01T15:00:00Z'); // 10:00 EST after the change at 02:00
    const out = calcularRecordatorios(fall, NY, REGLAS_RECORDATORIOS, new Date(fall.getTime() - 48 * H));
    expect(out.map((x) => fall.getTime() - x.cuando.getTime())).toEqual([24 * H, 4 * H, 2 * H]);
    expect(out[0]).toMatchObject({ localFecha: '2026-10-31', localHora: '11:00' }); // 24 h earlier is 11:00 local (EDT)
  });

  it('reports the local time in other US zones too, on the change day', () => {
    const spring = new Date('2027-03-14T17:00:00Z'); // 10:00 PDT
    const out = calcularRecordatorios(spring, 'America/Los_Angeles', REGLAS_RECORDATORIOS, new Date(spring.getTime() - 48 * H));
    expect(out[0]).toMatchObject({ localFecha: '2027-03-13', localHora: '09:00' });
    expect(out[2]).toMatchObject({ localFecha: '2027-03-14', localHora: '08:00' });
  });

  it('a notice before the gap is reported on the real wall clock', () => {
    const deadline = new Date('2027-03-14T07:30:00Z'); // 03:30 EDT, just after the gap
    const out = calcularRecordatorios(deadline, NY, { ...REGLAS_RECORDATORIOS, suplenteHoras: 1 }, new Date(deadline.getTime() - 48 * H));
    expect(out.find((x) => x.tipo === 'turno_suplente')).toMatchObject({ localHora: '01:30' }); // 06:30Z is 01:30 EST
  });

  it('honours custom rules and sorts the result even if the rules are out of order', () => {
    const out = calcularRecordatorios(plazo, NY, { recordatorioLargoHoras: 6, recordatorioCortoHoras: 12, suplenteHoras: 1 }, new Date(plazo.getTime() - 48 * H));
    expect(out.map((x) => plazo.getTime() - x.cuando.getTime())).toEqual([12 * H, 6 * H, 1 * H]);
  });

  it('refuses an unknown zone even when every notice is already due', () => {
    expect(() => calcularRecordatorios(plazo, 'Mars/Olympus', REGLAS_RECORDATORIOS, new Date(plazo.getTime() + H))).toThrow(InvalidLocalTimeError);
  });

  it('is deterministic and does not change its inputs', () => {
    const ahora = new Date(plazo.getTime() - 48 * H);
    const reglas = { ...REGLAS_RECORDATORIOS };
    const plazoMs = plazo.getTime();
    const a = calcularRecordatorios(plazo, NY, reglas, ahora);
    expect(calcularRecordatorios(plazo, NY, reglas, ahora)).toEqual(a);
    expect(plazo.getTime()).toBe(plazoMs);
    expect(reglas).toEqual(REGLAS_RECORDATORIOS);
  });
});

describe('the module is pure', () => {
  it('imports nothing from the database, the web server or the queue, and never reads the clock', () => {
    for (const file of ['estadoAprobacion.ts', 'recordatorios.ts', 'rondas.ts', 'types.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/from '(pg|pg-boss|fastify)'|\/db\/|Date\.now\(|new Date\(\)/);
    }
  });
});
