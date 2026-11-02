import { describe, expect, it } from 'vitest';
import { calcularGanancia, GANANCIA_MAXIMA_DB, juzgarSonoridad, OBJETIVO_LUFS, PICO_MAXIMO_DBTP, SILENCIO_LUFS, TOLERANCIA_LU } from './sonoridadVoz.js';

describe('calcularGanancia', () => {
  it('brings a measured mix to the target, rounded to 0.01 dB', () => {
    expect(calcularGanancia(-16)).toBe(0);
    expect(calcularGanancia(-22)).toBe(6);
    expect(calcularGanancia(-12.34)).toBe(-3.66);
    expect(calcularGanancia(-30.004)).toBe(14);
  });

  it('is bounded, and silence has no gain', () => {
    expect(calcularGanancia(SILENCIO_LUFS + 0.1)).toBe(GANANCIA_MAXIMA_DB);
    expect(calcularGanancia(20)).toBe(-GANANCIA_MAXIMA_DB);
    for (const silencio of [SILENCIO_LUFS, -70, Number.NaN, -Infinity, Infinity]) expect(calcularGanancia(silencio), String(silencio)).toBeNull();
  });
});

describe('juzgarSonoridad', () => {
  it('accepts the target +- 2 LU and a true peak up to -0.5 dBTP, at the limit', () => {
    expect(juzgarSonoridad({ integradaLufs: OBJETIVO_LUFS, picoVerdaderoDbtp: -3 })).toBe('en_rango');
    expect(juzgarSonoridad({ integradaLufs: OBJETIVO_LUFS - TOLERANCIA_LU, picoVerdaderoDbtp: PICO_MAXIMO_DBTP })).toBe('en_rango');
    expect(juzgarSonoridad({ integradaLufs: OBJETIVO_LUFS + TOLERANCIA_LU, picoVerdaderoDbtp: null })).toBe('en_rango');
  });

  it('refuses a mix that is too loud, too quiet or clipping, and tells silence apart', () => {
    expect(juzgarSonoridad({ integradaLufs: -13.9, picoVerdaderoDbtp: -3 })).toBe('volumen_fuera_de_rango');
    expect(juzgarSonoridad({ integradaLufs: -18.1, picoVerdaderoDbtp: -3 })).toBe('volumen_fuera_de_rango');
    expect(juzgarSonoridad({ integradaLufs: -16, picoVerdaderoDbtp: -0.4 })).toBe('volumen_fuera_de_rango');
    expect(juzgarSonoridad({ integradaLufs: -70, picoVerdaderoDbtp: null })).toBe('silencio');
    expect(juzgarSonoridad({ integradaLufs: Number.NaN, picoVerdaderoDbtp: null })).toBe('silencio');
  });
});
