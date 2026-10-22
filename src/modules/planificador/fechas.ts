import { InvalidLocalTimeError } from './errors.js';
import { DIAS, type Dia } from './types.js';

// Local time <-> UTC with Intl only (Node ships full ICU), no time-zone library. A plan is built in
// the client's zone and stored as timestamptz; never a local time without a zone.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ZONE_RE = /^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidZone(zone: string): boolean {
  if (typeof zone !== 'string' || !ZONE_RE.test(zone)) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The zone's wall clock at an instant, expressed as if it were UTC milliseconds. */
function wallMsAt(instantMs: number, zone: string): number {
  const parts = formatter(zone).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/** The local date (YYYY-MM-DD) and time (HH:mm) of an instant in `zone`. */
export function localLabel(instant: Date, zone: string): { fecha: string; hora: string } {
  if (!isValidZone(zone)) throw new InvalidLocalTimeError('zone');
  const iso = new Date(wallMsAt(instant.getTime(), zone)).toISOString();
  return { fecha: iso.slice(0, 10), hora: iso.slice(11, 16) };
}

/** Offset of the zone from UTC at an instant, in milliseconds (negative west of Greenwich). */
function offsetMsAt(instantMs: number, zone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  return wallMsAt(whole, zone) - whole;
}

/** Milliseconds since the epoch of a real YYYY-MM-DD at 00:00 UTC, or throws. */
function parseDateMs(localDate: string): number {
  const match = DATE_RE.exec(localDate);
  if (!match) throw new InvalidLocalTimeError('date');
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new InvalidLocalTimeError('date');
  }
  return ms;
}

export function isValidLocalDate(localDate: string): boolean {
  try {
    parseDateMs(localDate);
    return true;
  } catch {
    return false;
  }
}

export function isValidLocalTime(localTime: string): boolean {
  return TIME_RE.test(localTime);
}

/** Minutes after midnight of a valid HH:mm. */
export function minutesOf(localTime: string): number {
  const match = TIME_RE.exec(localTime);
  if (!match) throw new InvalidLocalTimeError('time');
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The UTC instant of a local date and time in `zone`.
 * - A time that does not exist (spring forward gap) throws InvalidLocalTimeError('nonexistent').
 * - An ambiguous time (fall back, it happens twice) takes the FIRST occurrence.
 */
export function toUtc(localDate: string, localTime: string, zone: string): Date {
  if (!isValidZone(zone)) throw new InvalidLocalTimeError('zone');
  const dateMs = parseDateMs(localDate);
  const wall = dateMs + minutesOf(localTime) * 60_000;

  // The offset a day before and a day after bracket any transition near this wall time. Each gives a
  // candidate instant; it counts only if the zone's wall clock at that instant is really `wall`.
  const candidates = new Set([wall - offsetMsAt(wall - DAY_MS, zone), wall - offsetMsAt(wall + DAY_MS, zone)]);
  const valid = [...candidates].filter((instant) => wallMsAt(instant, zone) === wall).sort((a, b) => a - b);
  if (valid.length === 0) throw new InvalidLocalTimeError('nonexistent');
  return new Date(valid[0]!);
}

/** YYYY-MM-DD of `localDate` plus `days` (may be negative). */
export function addDays(localDate: string, days: number): string {
  return new Date(parseDateMs(localDate) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The 7 local dates of a week, from its Monday. */
export function weekDates(semanaInicio: string): string[] {
  return Array.from({ length: 7 }, (_v, i) => addDays(semanaInicio, i));
}

/** Day of the week of a local date, with the names used in the profile (no accents). */
export function diaDeLaSemana(localDate: string): Dia {
  const sundayFirst = new Date(parseDateMs(localDate)).getUTCDay();
  return DIAS[(sundayFirst + 6) % 7]!;
}

/** The Monday on or before a local date. */
export function mondayOf(localDate: string): string {
  const sundayFirst = new Date(parseDateMs(localDate)).getUTCDay();
  return addDays(localDate, -((sundayFirst + 6) % 7));
}

/** The local date in `zone` of an instant. */
export function localDateOf(instant: Date, zone: string): string {
  if (!isValidZone(zone)) throw new InvalidLocalTimeError('zone');
  return new Date(wallMsAt(Math.floor(instant.getTime() / 1000) * 1000, zone)).toISOString().slice(0, 10);
}

/** The wall-clock date (YYYY-MM-DD) and time (HH:mm) of an instant in `zone`. */
export function localDateTimeOf(instant: Date, zone: string): { fecha: string; hora: string } {
  if (!isValidZone(zone)) throw new InvalidLocalTimeError('zone');
  const wall = new Date(wallMsAt(Math.floor(instant.getTime() / 1000) * 1000, zone)).toISOString();
  return { fecha: wall.slice(0, 10), hora: wall.slice(11, 16) };
}
