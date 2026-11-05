import { describe, expect, it } from 'vitest';
import { MetricasEntradaError } from './errors.js';
import { normalizarMetricasFake, ventanasDeMedicion, type MetricasNormalizadas } from './normalizarMetricas.js';

const TODO_NULL: MetricasNormalizadas = {
  impresiones: null,
  alcance: null,
  reproducciones: null,
  me_gusta: null,
  comentarios: null,
  compartidos: null,
  guardados: null,
  tiempo_reproduccion_promedio_seg: null,
  retencion_pct: null,
  visitas_perfil: null,
  clics_enlace: null,
  seguidores_ganados: null,
};

const COMPLETO = {
  impressions: 1000,
  reach: 800,
  plays: 600,
  likes: 50,
  comments: 5,
  shares: 4,
  saves: 7,
  avg_watch_time_seconds: 12.345,
  retention_percent: 41.678,
  profile_visits: 9,
  link_clicks: 3,
  followers_gained: 2,
};

describe('normalizarMetricasFake', () => {
  it('maps a complete raw shape to the fixed set', () => {
    expect(normalizarMetricasFake(COMPLETO)).toEqual({
      impresiones: 1000,
      alcance: 800,
      reproducciones: 600,
      me_gusta: 50,
      comentarios: 5,
      compartidos: 4,
      guardados: 7,
      tiempo_reproduccion_promedio_seg: 12.35,
      retencion_pct: 41.68,
      visitas_perfil: 9,
      clics_enlace: 3,
      seguidores_ganados: 2,
    });
  });

  it('a metric the network does not report is NULL, never 0; an empty object is all NULL', () => {
    expect(normalizarMetricasFake({})).toEqual(TODO_NULL);
    const parcial = normalizarMetricasFake({ impressions: 10, likes: 0 });
    expect(parcial.impresiones).toBe(10);
    expect(parcial.me_gusta).toBe(0);
    expect(parcial.alcance).toBeNull();
    expect(parcial.guardados).toBeNull();
  });

  it('null and undefined values are NULL', () => {
    expect(normalizarMetricasFake({ impressions: null, reach: undefined })).toEqual(TODO_NULL);
  });

  it('an invalid value is NULL for that metric only; the rest of the snapshot is kept', () => {
    const r = normalizarMetricasFake({
      ...COMPLETO,
      impressions: -1,
      reach: Number.NaN,
      plays: Number.POSITIVE_INFINITY,
      likes: 1.5,
      comments: '5',
      shares: Number.MAX_SAFE_INTEGER + 2,
      retention_percent: 100.01,
      avg_watch_time_seconds: -0.5,
    });
    expect(r.impresiones).toBeNull();
    expect(r.alcance).toBeNull();
    expect(r.reproducciones).toBeNull();
    expect(r.me_gusta).toBeNull();
    expect(r.comentarios).toBeNull();
    expect(r.compartidos).toBeNull();
    expect(r.retencion_pct).toBeNull();
    expect(r.tiempo_reproduccion_promedio_seg).toBeNull();
    // Untouched metrics survive.
    expect(r.guardados).toBe(7);
    expect(r.visitas_perfil).toBe(9);
    expect(r.clics_enlace).toBe(3);
    expect(r.seguidores_ganados).toBe(2);
  });

  it('percentage limits: 0 and 100 are valid, below 0 and above 100 are NULL', () => {
    expect(normalizarMetricasFake({ retention_percent: 0 }).retencion_pct).toBe(0);
    expect(normalizarMetricasFake({ retention_percent: 100 }).retencion_pct).toBe(100);
    expect(normalizarMetricasFake({ retention_percent: -0.01 }).retencion_pct).toBeNull();
    expect(normalizarMetricasFake({ retention_percent: 100.5 }).retencion_pct).toBeNull();
  });

  it('safe integers only: the largest safe integer passes, the next one is NULL (no bigint)', () => {
    expect(normalizarMetricasFake({ impressions: Number.MAX_SAFE_INTEGER }).impresiones).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizarMetricasFake({ impressions: 2 ** 53 }).impresiones).toBeNull();
    expect(typeof normalizarMetricasFake({ impressions: 5 }).impresiones).toBe('number');
  });

  it('watch time that would overflow numeric(10,2) is NULL', () => {
    expect(normalizarMetricasFake({ avg_watch_time_seconds: 99_999_999 }).tiempo_reproduccion_promedio_seg).toBe(99_999_999);
    expect(normalizarMetricasFake({ avg_watch_time_seconds: 100_000_000 }).tiempo_reproduccion_promedio_seg).toBeNull();
  });

  it('ignores keys it does not know and keys inherited from the prototype', () => {
    const raw = Object.create({ impressions: 99 }) as Record<string, unknown>;
    raw['unknown_metric'] = 5;
    expect(normalizarMetricasFake(raw)).toEqual(TODO_NULL);
  });

  it('does not change its input', () => {
    const copia = JSON.parse(JSON.stringify(COMPLETO)) as typeof COMPLETO;
    normalizarMetricasFake(COMPLETO);
    expect(COMPLETO).toEqual(copia);
  });

  it('throws only when the raw value is not an object', () => {
    for (const raw of [null, undefined, 5, 'texto', [], true]) expect(() => normalizarMetricasFake(raw)).toThrow(MetricasEntradaError);
  });
});

describe('ventanasDeMedicion', () => {
  it('gives the four windows of spec 12.1 as absolute offsets from the publication', () => {
    const r = ventanasDeMedicion(new Date('2026-03-07T12:00:00Z'));
    expect(r.map((v) => v.ventana)).toEqual(['24h', '72h', '7d', '28d']);
    expect(r.map((v) => v.en.toISOString())).toEqual([
      '2026-03-08T12:00:00.000Z',
      '2026-03-10T12:00:00.000Z',
      '2026-03-14T12:00:00.000Z',
      '2026-04-04T12:00:00.000Z',
    ]);
  });
});
