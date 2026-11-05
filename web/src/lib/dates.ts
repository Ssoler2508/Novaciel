const dateTimeFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
const dateFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'UTC' });

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidLocalDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

export function formatDateOnly(value: string): string {
  const date = new Date(isValidLocalDate(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}
