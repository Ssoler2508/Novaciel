import { es } from '../i18n/index.js';

const integerFormatter = new Intl.NumberFormat('es-ES');
const decimalFormatter = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
const sizeFormatter = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });

export function textOrPlaceholder(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : es.common.notAvailable;
}

export function formatNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? integerFormatter.format(value)
    : es.common.notAvailable;
}

export function formatDecimal(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? decimalFormatter.format(value)
    : es.common.notAvailable;
}

export function formatBytes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return es.common.notAvailable;
  }
  if (value < 1024) return `${integerFormatter.format(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${sizeFormatter.format(size)} ${units[index]}`;
}

export function formatSecondsFromMs(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${decimalFormatter.format(value / 1000)} s`
    : es.common.notAvailable;
}

export function formatMsRange(
  entrada: number | null | undefined,
  salida: number | null | undefined,
): string {
  if (typeof entrada !== 'number' || typeof salida !== 'number') return es.common.notAvailable;
  return `${formatSecondsFromMs(entrada)} – ${formatSecondsFromMs(salida)}`;
}
