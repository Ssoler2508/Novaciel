import { MetricasEntradaError } from './errors.js';

// Metrics normalization (Step 10, checkpoint B). PURE. A provider's raw shape becomes the fixed set of
// metricas_pieza columns. A metric the network does not report, or reports with an invalid value
// (negative, not finite, not an integer for a count, a percentage outside 0..100), is NULL for that
// metric ONLY; the rest of the snapshot is kept. Never 0 for "unknown". Counts are plain numbers that
// pass Number.isSafeInteger; there is no bigint.

export const VENTANAS = ['24h', '72h', '7d', '28d'] as const;
export type VentanaMetricas = (typeof VENTANAS)[number];

/** Spec 12.1: 24 hours, 3 days, 7 days and 28 days after publishing. */
export function ventanasDeMedicion(publicadaEn: Date): { ventana: VentanaMetricas; en: Date }[] {
  const hora = 60 * 60_000;
  const horas: Record<VentanaMetricas, number> = { '24h': 24, '72h': 72, '7d': 7 * 24, '28d': 28 * 24 };
  return VENTANAS.map((ventana) => ({ ventana, en: new Date(publicadaEn.getTime() + horas[ventana] * hora) }));
}

/** The columns of metricas_pieza that hold metrics. */
export interface MetricasNormalizadas {
  impresiones: number | null;
  alcance: number | null;
  reproducciones: number | null;
  me_gusta: number | null;
  comentarios: number | null;
  compartidos: number | null;
  guardados: number | null;
  tiempo_reproduccion_promedio_seg: number | null;
  retencion_pct: number | null;
  visitas_perfil: number | null;
  clics_enlace: number | null;
  seguidores_ganados: number | null;
}

/** The raw shape of the fake provider (real providers get their own mapping in checkpoint F). */
export const CLAVES_FAKE: Readonly<Record<keyof MetricasNormalizadas, string>> = {
  impresiones: 'impressions',
  alcance: 'reach',
  reproducciones: 'plays',
  me_gusta: 'likes',
  comentarios: 'comments',
  compartidos: 'shares',
  guardados: 'saves',
  tiempo_reproduccion_promedio_seg: 'avg_watch_time_seconds',
  retencion_pct: 'retention_percent',
  visitas_perfil: 'profile_visits',
  clics_enlace: 'link_clicks',
  seguidores_ganados: 'followers_gained',
};

// numeric(10,2): at most 8 integer digits.
const MAX_SEGUNDOS = 99_999_999;

function conteo(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
}

function redondear2(valor: number): number {
  return Math.round(valor * 100) / 100;
}

function segundos(valor: unknown): number | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0 || valor > MAX_SEGUNDOS) return null;
  return redondear2(valor);
}

function porcentaje(valor: unknown): number | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0 || valor > 100) return null;
  return redondear2(valor);
}

/** Throws MetricasEntradaError only when `raw` is not an object; anything else invalid becomes NULL per metric. */
export function normalizarMetricasFake(raw: unknown): MetricasNormalizadas {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MetricasEntradaError('no_es_objeto');
  const leer = (clave: keyof MetricasNormalizadas): unknown => {
    const origen = CLAVES_FAKE[clave];
    return Object.prototype.hasOwnProperty.call(raw, origen) ? (raw as Record<string, unknown>)[origen] : undefined;
  };
  return {
    impresiones: conteo(leer('impresiones')),
    alcance: conteo(leer('alcance')),
    reproducciones: conteo(leer('reproducciones')),
    me_gusta: conteo(leer('me_gusta')),
    comentarios: conteo(leer('comentarios')),
    compartidos: conteo(leer('compartidos')),
    guardados: conteo(leer('guardados')),
    tiempo_reproduccion_promedio_seg: segundos(leer('tiempo_reproduccion_promedio_seg')),
    retencion_pct: porcentaje(leer('retencion_pct')),
    visitas_perfil: conteo(leer('visitas_perfil')),
    clics_enlace: conteo(leer('clics_enlace')),
    seguidores_ganados: conteo(leer('seguidores_ganados')),
  };
}
