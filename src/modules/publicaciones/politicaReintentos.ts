import { PoliticaReintentosEntradaError } from './errors.js';

// Retry policy of a publication (Step 10, checkpoint B). PURE: randomness comes in as an argument.
// Transient errors (rate limit, server, timeout) are retried with a growing, jittered, bounded wait;
// auth, quota and bad request are not; an unknown outcome is never resent blindly (look it up by key).

/** Error categories: the closed set of publicaciones_resultados.categoria_error. */
export const CATEGORIAS_ERROR = [
  'auth',
  'quota',
  'rate_limit',
  'bad_request',
  'server',
  'timeout',
  'resultado_desconocido',
  'etiqueta_ia_no_soportada',
] as const;
export type CategoriaError = (typeof CATEGORIAS_ERROR)[number];

/** Alert codes of the ADR-09 catalogue that this policy can ask for. */
export type AlertaPublicacion =
  | 'publicacion_fallida'
  | 'publicacion_resultado_desconocido'
  | 'conexion_red_vencida'
  | 'etiqueta_ia_no_soportada';

/** All values VERIFY. */
export const MAX_INTENTOS = 3; // the first send plus 2 retries (spec 11.4)
export const ESPERA_BASE_MS = 30_000;
export const FACTOR_ESPERA = 4;
export const ESPERA_MAXIMA_MS = 10 * 60_000;
export const JITTER = 0.2;

const REINTENTABLES: ReadonlySet<CategoriaError> = new Set(['rate_limit', 'server', 'timeout']);

export type DecisionReintento =
  | { accion: 'reintentar'; esperaMs: number }
  | { accion: 'detener'; alerta: AlertaPublicacion; razon: 'no_reintentable' | 'sin_reintentos' | 'espera_excesiva' }
  /** The outcome is unknown: look the attempt up by its idempotency key before anything else. Never resend blindly. */
  | { accion: 'verificar'; alerta: 'publicacion_resultado_desconocido' };

/** The wait before retry number `reintento` (1 = first retry): base * factor^(n-1), jittered by +-20 %, capped. */
export function esperaReintentoMs(reintento: number, azar: number): number {
  if (!Number.isInteger(reintento) || reintento < 1) throw new PoliticaReintentosEntradaError('intentos_invalidos');
  if (!(azar >= 0 && azar < 1)) throw new PoliticaReintentosEntradaError('azar_invalido');
  const sinJitter = ESPERA_BASE_MS * FACTOR_ESPERA ** (reintento - 1);
  const factor = 1 - JITTER + 2 * JITTER * azar;
  return Math.min(ESPERA_MAXIMA_MS, Math.round(sinJitter * factor));
}

function alertaDe(categoria: CategoriaError): AlertaPublicacion {
  if (categoria === 'auth') return 'conexion_red_vencida';
  if (categoria === 'etiqueta_ia_no_soportada') return 'etiqueta_ia_no_soportada';
  return 'publicacion_fallida';
}

export interface EntradaDecision {
  categoria: CategoriaError;
  /** Attempts already made for this production, counting the one that just failed (>= 1). */
  intentosHechos: number;
  /** The provider's Retry-After in milliseconds, when it sent one. */
  retryAfterMs?: number;
  /** In [0, 1). */
  azar: number;
}

export function decidirReintento(e: EntradaDecision): DecisionReintento {
  if (!Number.isInteger(e.intentosHechos) || e.intentosHechos < 1) throw new PoliticaReintentosEntradaError('intentos_invalidos');
  if (e.retryAfterMs !== undefined && !(Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0)) throw new PoliticaReintentosEntradaError('espera_invalida');

  if (e.categoria === 'resultado_desconocido') return { accion: 'verificar', alerta: 'publicacion_resultado_desconocido' };
  if (!REINTENTABLES.has(e.categoria)) return { accion: 'detener', alerta: alertaDe(e.categoria), razon: 'no_reintentable' };
  if (e.intentosHechos >= MAX_INTENTOS) return { accion: 'detener', alerta: 'publicacion_fallida', razon: 'sin_reintentos' };

  if (e.retryAfterMs !== undefined) {
    // The provider's wait is respected as sent: never shortened. Too long to wait for: stop and alert.
    if (e.retryAfterMs > ESPERA_MAXIMA_MS) return { accion: 'detener', alerta: 'publicacion_fallida', razon: 'espera_excesiva' };
    return { accion: 'reintentar', esperaMs: Math.ceil(e.retryAfterMs) };
  }
  return { accion: 'reintentar', esperaMs: esperaReintentoMs(e.intentosHechos, e.azar) };
}
