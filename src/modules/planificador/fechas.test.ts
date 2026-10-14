import { describe, expect, it } from 'vitest';
import { InvalidLocalTimeError } from './errors.js';
import {
  addDays,
  diaDeLaSemana,
  isValidLocalDate,
  isValidLocalTime,
  isValidZone,
  localDateOf,
  mondayOf,
  toUtc,
  weekDates,
} from './fechas.js';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const utc = (date: string, time: string, zone: string) => toUtc(date, time, zone).toISOString();

describe('toUtc: ordinary offsets', () => {
  it('uses standard time in winter and daylight time in summer', () => {
    expect(utc('2026-01-15', '09:00', NY)).toBe('2026-01-15T14:00:00.000Z'); // EST, UTC-5
    expect(utc('2026-07-15', '09:00', NY)).toBe('2026-07-15T13:00:00.000Z'); // EDT, UTC-4
    expect(utc('2026-01-15', '09:00', LA)).toBe('2026-01-15T17:00:00.000Z'); // PST, UTC-8
    expect(utc('2026-07-15', '09:00', LA)).toBe('2026-07-15T16:00:00.000Z'); // PDT, UTC-7
  });

  it('crosses midnight in UTC correctly', () => {
    expect(utc('2026-11-03', '22:30', NY)).toBe('2026-11-04T03:30:00.000Z');
    expect(utc('2026-11-03', '00:00', LA)).toBe('2026-11-03T08:00:00.000Z');
  });

  it('works for UTC itself and for a zone without daylight saving', () => {
    expect(utc('2026-11-03', '10:00', 'UTC')).toBe('2026-11-03T10:00:00.000Z');
    expect(utc('2026-07-03', '10:00', 'America/Bogota')).toBe('2026-07-03T15:00:00.000Z');
  });
});

describe('toUtc: spring forward (2026-03-08, 02:00 jumps to 03:00)', () => {
  it('accepts the last minute before the gap and the first after it', () => {
    expect(utc('2026-03-08', '01:59', NY)).toBe('2026-03-08T06:59:00.000Z'); // EST
    expect(utc('2026-03-08', '03:00', NY)).toBe('2026-03-08T07:00:00.000Z'); // EDT
    expect(utc('2026-03-08', '01:59', LA)).toBe('2026-03-08T09:59:00.000Z'); // PST
    expect(utc('2026-03-08', '03:00', LA)).toBe('2026-03-08T10:00:00.000Z'); // PDT
  });

  it('rejects every local time inside the gap', () => {
    for (const zone of [NY, LA]) {
      for (const time of ['02:00', '02:01', '02:30', '02:59']) {
        const error = (() => {
          try {
            toUtc('2026-03-08', time, zone);
          } catch (e) {
            return e;
          }
        })();
        expect(error, `${zone} ${time}`).toBeInstanceOf(InvalidLocalTimeError);
        expect(error).toMatchObject({ reason: 'nonexistent' });
      }
    }
  });

  it('02:30 exists on the days around the gap', () => {
    expect(utc('2026-03-07', '02:30', NY)).toBe('2026-03-07T07:30:00.000Z');
    expect(utc('2026-03-09', '02:30', NY)).toBe('2026-03-09T06:30:00.000Z');
  });
});

describe('toUtc: fall back (2026-11-01, 02:00 returns to 01:00)', () => {
  it('takes the FIRST occurrence of an ambiguous time', () => {
    expect(utc('2026-11-01', '01:30', NY)).toBe('2026-11-01T05:30:00.000Z'); // EDT, before the change
    expect(utc('2026-11-01', '01:00', NY)).toBe('2026-11-01T05:00:00.000Z');
    expect(utc('2026-11-01', '01:59', NY)).toBe('2026-11-01T05:59:00.000Z');
    expect(utc('2026-11-01', '01:30', LA)).toBe('2026-11-01T08:30:00.000Z'); // PDT
  });

  it('leaves the unambiguous times around it alone', () => {
    expect(utc('2026-11-01', '00:59', NY)).toBe('2026-11-01T04:59:00.000Z'); // EDT
    expect(utc('2026-11-01', '02:00', NY)).toBe('2026-11-01T07:00:00.000Z'); // EST
    expect(utc('2026-11-01', '02:00', LA)).toBe('2026-11-01T10:00:00.000Z'); // PST
  });
});

describe('toUtc: invalid input', () => {
  const reasonOf = (date: string, time: string, zone: string) => {
    try {
      toUtc(date, time, zone);
    } catch (error) {
      return (error as InvalidLocalTimeError).reason;
    }
    return 'ok';
  };

  it('rejects unknown zones, impossible dates and malformed times', () => {
    expect(reasonOf('2026-11-03', '10:00', 'Mars/Base')).toBe('zone');
    expect(reasonOf('2026-11-03', '10:00', '')).toBe('zone');
    expect(reasonOf('2026-11-03', '10:00', 'new_york')).toBe('zone');
    for (const date of ['2026-02-30', '2026-13-01', '2026-1-1', '26-11-03', '2026-11-3', 'tomorrow', '']) {
      expect(reasonOf(date, '10:00', NY), date).toBe('date');
    }
    for (const time of ['24:00', '9:00', '12:60', '10:00:00', '', '10h']) {
      expect(reasonOf('2026-11-03', time, NY), time).toBe('time');
    }
  });

  it('knows the 29th of February only in leap years', () => {
    expect(isValidLocalDate('2028-02-29')).toBe(true);
    expect(isValidLocalDate('2027-02-29')).toBe(false);
  });

  it('error messages carry no input', () => {
    try {
      toUtc('2026-03-08', '02:30', NY);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/2026|02:30|New_York/);
    }
  });
});

describe('validators', () => {
  it('isValidZone', () => {
    expect(isValidZone(NY)).toBe(true);
    expect(isValidZone('UTC')).toBe(true);
    expect(isValidZone('Mars/Base')).toBe(false);
    expect(isValidZone('')).toBe(false);
    expect(isValidZone('EST5EDT-x')).toBe(false);
  });

  it('isValidLocalTime', () => {
    expect(['00:00', '23:59', '09:05'].every(isValidLocalTime)).toBe(true);
    expect(['24:00', '9:05', '09:5', '09:60'].some(isValidLocalTime)).toBe(false);
  });
});

describe('week helpers', () => {
  it('weekDates lists 7 days from Monday, also across a month and a DST change', () => {
    expect(weekDates('2026-11-02')).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(weekDates('2026-10-26')).toContain('2026-11-01');
    expect(weekDates('2026-03-02')).toContain('2026-03-08');
    expect(weekDates('2026-12-28')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  });

  it('addDays handles negative amounts and leap days', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('diaDeLaSemana uses the profile names without accents', () => {
    expect(diaDeLaSemana('2026-11-02')).toBe('lunes');
    expect(diaDeLaSemana('2026-11-04')).toBe('miercoles');
    expect(diaDeLaSemana('2026-11-07')).toBe('sabado');
    expect(diaDeLaSemana('2026-11-08')).toBe('domingo');
  });

  it('mondayOf finds the Monday on or before a date', () => {
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(mondayOf('2026-11-03')).toBe('2026-11-02');
    expect(mondayOf('2026-03-01')).toBe('2026-02-23');
  });

  it('localDateOf and mondayOf resolve a Sunday night in New York to the right week', () => {
    // 03:30 UTC on Monday 2026-11-02 is still Sunday evening (22:30) in New York.
    const instant = new Date('2026-11-02T03:30:00Z');
    expect(localDateOf(instant, NY)).toBe('2026-11-01');
    expect(mondayOf(localDateOf(instant, NY))).toBe('2026-10-26');
    expect(mondayOf(localDateOf(instant, 'UTC'))).toBe('2026-11-02');
    expect(() => localDateOf(instant, 'Mars/Base')).toThrow(InvalidLocalTimeError);
  });
});
