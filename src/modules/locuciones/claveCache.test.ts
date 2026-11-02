import { describe, expect, it } from 'vitest';
import { claveCache, CLAVE_CACHE_VERSION, type AjustesVoz, type EntradaClaveCache } from './claveCache.js';
import { LocucionEntradaInvalidaError } from './errors.js';

const BASE: EntradaClaveCache = {
  texto: 'Prueba el café de la casa',
  vozId: 'voz-ficticia-1',
  modeloId: 'modelo-tts-ficticio',
  ajustes: { estabilidad: 0.5, similitud: 0.75, estilo: 0, velocidad: 1, refuerzoVoz: true, idioma: 'es' },
  formato: 'mp3_44100_128',
};

const con = (cambios: Partial<EntradaClaveCache>): EntradaClaveCache => ({ ...BASE, ...cambios });
const conAjustes = (cambios: Partial<AjustesVoz>): EntradaClaveCache => ({ ...BASE, ajustes: { ...BASE.ajustes, ...cambios } });

/** Frozen vector of lc1: if this changes, the serialization changed and it must become lc2. */
const VECTOR_LC1 = 'd1f833aded7211893ac004d0633a73da2c4a1302834a9b38e19e49c0cc7efb71';

describe('claveCache', () => {
  it('is a 64-character lowercase hex SHA-256 and the version is lc1', () => {
    expect(CLAVE_CACHE_VERSION).toBe('lc1');
    expect(claveCache(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the frozen lc1 vector', () => {
    expect(claveCache(BASE)).toBe(VECTOR_LC1);
  });

  it('is stable: the same input gives the same key, whatever the order of the settings keys', () => {
    expect(claveCache(BASE)).toBe(claveCache(structuredClone(BASE)));
    const reordenado = {
      ...BASE,
      ajustes: { idioma: 'es', refuerzoVoz: true, velocidad: 1, estilo: 0, similitud: 0.75, estabilidad: 0.5 },
    } as EntradaClaveCache;
    expect(claveCache(reordenado)).toBe(claveCache(BASE));
  });

  it('does not depend on NFC vs NFD of the text, and treats -0 as 0', () => {
    expect(claveCache(con({ texto: 'Prueba el café de la casa' }))).toBe(claveCache(BASE));
    expect(claveCache(conAjustes({ estilo: -0 }))).toBe(claveCache(BASE));
  });

  it('changes with every input', () => {
    const base = claveCache(BASE);
    const variantes: [string, EntradaClaveCache][] = [
      ['texto', con({ texto: 'Prueba el café de la casa.' })],
      ['texto mayúscula', con({ texto: 'prueba el café de la casa' })],
      ['voz', con({ vozId: 'voz-ficticia-2' })],
      ['modelo', con({ modeloId: 'modelo-tts-ficticio-2' })],
      ['formato', con({ formato: 'mp3_44100_192' })],
      ['estabilidad', conAjustes({ estabilidad: 0.51 })],
      ['similitud', conAjustes({ similitud: 0.76 })],
      ['estilo', conAjustes({ estilo: 0.1 })],
      ['velocidad', conAjustes({ velocidad: 1.05 })],
      ['refuerzo', conAjustes({ refuerzoVoz: false })],
      ['idioma', conAjustes({ idioma: 'en' })],
      ['sin idioma', conAjustes({ idioma: null })],
    ];
    const claves = new Set([base]);
    for (const [nombre, v] of variantes) {
      const k = claveCache(v);
      expect(k, nombre).not.toBe(base);
      claves.add(k);
    }
    expect(claves.size).toBe(variantes.length + 1);
  });

  it('cannot confuse neighbouring fields (length-prefixed strings)', () => {
    expect(claveCache(con({ vozId: 'ab', modeloId: 'c' }))).not.toBe(claveCache(con({ vozId: 'a', modeloId: 'bc' })));
    expect(claveCache(con({ texto: 'a', vozId: 'bc' }))).not.toBe(claveCache(con({ texto: 'ab', vozId: 'c' })));
  });

  it('refuses empty fields, lone surrogates, out-of-range settings and a bad language', () => {
    const razon = (e: EntradaClaveCache): string => {
      try {
        claveCache(e);
      } catch (error) {
        expect(error).toBeInstanceOf(LocucionEntradaInvalidaError);
        return (error as LocucionEntradaInvalidaError).reason;
      }
      throw new Error('expected a refusal');
    };
    expect(razon(con({ texto: '  ' }))).toBe('campo_vacio');
    expect(razon(con({ vozId: '' }))).toBe('campo_vacio');
    expect(razon(con({ modeloId: ' ' }))).toBe('campo_vacio');
    expect(razon(con({ formato: '' }))).toBe('campo_vacio');
    expect(razon(con({ texto: 'mal\ud800formado' }))).toBe('texto_mal_formado');
    for (const ajustes of [{ estabilidad: -0.1 }, { estabilidad: 1.1 }, { similitud: Number.NaN }, { estilo: Infinity }, { velocidad: 0.5 }, { velocidad: 1.3 }]) {
      expect(razon(conAjustes(ajustes))).toBe('ajuste_fuera_de_rango');
    }
    expect(razon(conAjustes({ idioma: 'ES' }))).toBe('idioma_invalido');
    expect(razon(conAjustes({ idioma: 'esp' }))).toBe('idioma_invalido');
  });
});
