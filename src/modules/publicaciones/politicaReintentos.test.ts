import { describe, expect, it } from 'vitest';
import { PoliticaReintentosEntradaError } from './errors.js';
import {
  CATEGORIAS_ERROR,
  ESPERA_BASE_MS,
  ESPERA_MAXIMA_MS,
  MAX_INTENTOS,
  decidirReintento,
  esperaReintentoMs,
  type CategoriaError,
} from './politicaReintentos.js';

describe('esperaReintentoMs', () => {
  it('grows by a factor of 4 from 30 s with no jitter at the midpoint', () => {
    expect(esperaReintentoMs(1, 0.5)).toBe(30_000);
    expect(esperaReintentoMs(2, 0.5)).toBe(120_000);
    expect(esperaReintentoMs(3, 0.5)).toBe(480_000);
  });

  it('is capped at 10 minutes, jitter included', () => {
    expect(esperaReintentoMs(4, 0.5)).toBe(ESPERA_MAXIMA_MS);
    expect(esperaReintentoMs(10, 0.999)).toBe(ESPERA_MAXIMA_MS);
    for (let n = 1; n <= 12; n++) for (const azar of [0, 0.25, 0.5, 0.75, 0.999999]) expect(esperaReintentoMs(n, azar)).toBeLessThanOrEqual(ESPERA_MAXIMA_MS);
  });

  it('keeps the jitter within +-20 % and is monotonic in the random value', () => {
    expect(esperaReintentoMs(1, 0)).toBe(24_000);
    expect(esperaReintentoMs(1, 0.999999)).toBeLessThanOrEqual(36_000);
    expect(esperaReintentoMs(1, 0.999999)).toBeGreaterThanOrEqual(35_999);
    let anterior = 0;
    for (let i = 0; i < 100; i++) {
      const v = esperaReintentoMs(2, i / 100);
      expect(v).toBeGreaterThanOrEqual(anterior);
      anterior = v;
    }
  });

  it('is deterministic for the same random value', () => {
    expect(esperaReintentoMs(2, 0.3)).toBe(esperaReintentoMs(2, 0.3));
  });

  it('rejects bad arguments', () => {
    expect(() => esperaReintentoMs(0, 0.5)).toThrow(PoliticaReintentosEntradaError);
    expect(() => esperaReintentoMs(1.5, 0.5)).toThrow(PoliticaReintentosEntradaError);
    expect(() => esperaReintentoMs(1, 1)).toThrow(PoliticaReintentosEntradaError);
    expect(() => esperaReintentoMs(1, -0.1)).toThrow(PoliticaReintentosEntradaError);
    expect(() => esperaReintentoMs(1, Number.NaN)).toThrow(PoliticaReintentosEntradaError);
  });
});

describe('decidirReintento', () => {
  const azar = 0.5;

  it('retries transient categories with a growing wait until the attempts run out', () => {
    for (const categoria of ['rate_limit', 'server', 'timeout'] as CategoriaError[]) {
      expect(decidirReintento({ categoria, intentosHechos: 1, azar })).toEqual({ accion: 'reintentar', esperaMs: ESPERA_BASE_MS });
      expect(decidirReintento({ categoria, intentosHechos: 2, azar })).toEqual({ accion: 'reintentar', esperaMs: ESPERA_BASE_MS * 4 });
      expect(decidirReintento({ categoria, intentosHechos: MAX_INTENTOS, azar })).toEqual({ accion: 'detener', alerta: 'publicacion_fallida', razon: 'sin_reintentos' });
      expect(decidirReintento({ categoria, intentosHechos: MAX_INTENTOS + 5, azar })).toEqual({ accion: 'detener', alerta: 'publicacion_fallida', razon: 'sin_reintentos' });
    }
    expect(MAX_INTENTOS).toBe(3);
  });

  it('never retries auth, quota, bad request or an unsupported AI label, and asks for the right alert', () => {
    expect(decidirReintento({ categoria: 'auth', intentosHechos: 1, azar })).toEqual({ accion: 'detener', alerta: 'conexion_red_vencida', razon: 'no_reintentable' });
    expect(decidirReintento({ categoria: 'quota', intentosHechos: 1, azar })).toEqual({ accion: 'detener', alerta: 'publicacion_fallida', razon: 'no_reintentable' });
    expect(decidirReintento({ categoria: 'bad_request', intentosHechos: 1, azar })).toEqual({ accion: 'detener', alerta: 'publicacion_fallida', razon: 'no_reintentable' });
    expect(decidirReintento({ categoria: 'etiqueta_ia_no_soportada', intentosHechos: 1, azar })).toEqual({
      accion: 'detener',
      alerta: 'etiqueta_ia_no_soportada',
      razon: 'no_reintentable',
    });
  });

  it('an unknown outcome is never resent: it is verified by key, at any attempt, with an alert', () => {
    for (const intentosHechos of [1, 2, 3, 9]) {
      expect(decidirReintento({ categoria: 'resultado_desconocido', intentosHechos, azar })).toEqual({ accion: 'verificar', alerta: 'publicacion_resultado_desconocido' });
    }
  });

  it('respects a Retry-After within the cap as sent, never shorter', () => {
    expect(decidirReintento({ categoria: 'rate_limit', intentosHechos: 1, retryAfterMs: 5_000, azar })).toEqual({ accion: 'reintentar', esperaMs: 5_000 });
    expect(decidirReintento({ categoria: 'rate_limit', intentosHechos: 1, retryAfterMs: 300_000, azar })).toEqual({ accion: 'reintentar', esperaMs: 300_000 });
    expect(decidirReintento({ categoria: 'rate_limit', intentosHechos: 1, retryAfterMs: ESPERA_MAXIMA_MS, azar })).toEqual({ accion: 'reintentar', esperaMs: ESPERA_MAXIMA_MS });
    expect(decidirReintento({ categoria: 'server', intentosHechos: 2, retryAfterMs: 1_500.2, azar })).toEqual({ accion: 'reintentar', esperaMs: 1_501 });
  });

  it('a Retry-After above the cap is not shortened: it stops with an alert', () => {
    expect(decidirReintento({ categoria: 'rate_limit', intentosHechos: 1, retryAfterMs: ESPERA_MAXIMA_MS + 1, azar })).toEqual({
      accion: 'detener',
      alerta: 'publicacion_fallida',
      razon: 'espera_excesiva',
    });
    expect(decidirReintento({ categoria: 'rate_limit', intentosHechos: 2, retryAfterMs: 3_600_000, azar })).toEqual({
      accion: 'detener',
      alerta: 'publicacion_fallida',
      razon: 'espera_excesiva',
    });
  });

  it('out of attempts wins over a Retry-After', () => {
    expect(decidirReintento({ categoria: 'rate_limit', intentosHechos: MAX_INTENTOS, retryAfterMs: 1_000, azar })).toEqual({
      accion: 'detener',
      alerta: 'publicacion_fallida',
      razon: 'sin_reintentos',
    });
  });

  it('ignores Retry-After for categories that are not retried', () => {
    expect(decidirReintento({ categoria: 'quota', intentosHechos: 1, retryAfterMs: 1_000, azar }).accion).toBe('detener');
  });

  it('every category has a decision, and only transient ones can ever retry', () => {
    for (const categoria of CATEGORIAS_ERROR) {
      const d = decidirReintento({ categoria, intentosHechos: 1, azar });
      expect(d.accion === 'reintentar').toBe(categoria === 'rate_limit' || categoria === 'server' || categoria === 'timeout');
    }
  });

  it('rejects bad arguments', () => {
    expect(() => decidirReintento({ categoria: 'server', intentosHechos: 0, azar })).toThrow(PoliticaReintentosEntradaError);
    expect(() => decidirReintento({ categoria: 'server', intentosHechos: 1.5, azar })).toThrow(PoliticaReintentosEntradaError);
    expect(() => decidirReintento({ categoria: 'server', intentosHechos: 1, retryAfterMs: -1, azar })).toThrow(PoliticaReintentosEntradaError);
    expect(() => decidirReintento({ categoria: 'server', intentosHechos: 1, retryAfterMs: Number.NaN, azar })).toThrow(PoliticaReintentosEntradaError);
    expect(() => decidirReintento({ categoria: 'server', intentosHechos: 1, azar: 1 })).toThrow(PoliticaReintentosEntradaError);
  });
});
