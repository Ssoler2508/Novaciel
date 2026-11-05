// Spanish date formatting. Date-only values (semana_inicio) are kept in UTC so the calendar day
// never shifts with the browser time zone.
const dateTimeFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
const dateFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'UTC' });

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

export function formatDateOnly(value: string): string {
  const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}
