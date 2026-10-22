import { describe, expect, it } from 'vitest';
import { TiemposInvalidosError } from './errors.js';
import { calcularTiemposPalabras, palabrasDe, REGLAS_TIEMPOS, type ReglasTiempos } from './tiemposPalabras.js';

const SIN_ENTRADA: ReglasTiempos = { entradaMs: 0, retencionFinalMinMs: 0, minimoPorPalabraMs: 1 };

/** The invariants every result must hold, whatever the text or the duration. */
function invariantes(texto: string, duracionMs: number, reglas?: ReglasTiempos) {
  const r = calcularTiemposPalabras(texto, duracionMs, reglas);
  expect(r.map((t) => t.palabra)).toEqual(palabrasDe(texto));
  for (const [i, t] of r.entries()) {
    expect(Number.isInteger(t.inicioMs) && Number.isInteger(t.finMs)).toBe(true);
    expect(t.inicioMs).toBeGreaterThanOrEqual(0);
    expect(t.finMs).toBeLessThanOrEqual(duracionMs); // never beyond the scene
    expect(t.finMs).toBeGreaterThan(t.inicioMs); // every word is on screen for some time
    if (i > 0) {
      expect(t.inicioMs).toBeGreaterThan(r[i - 1]!.inicioMs); // strictly increasing starts
      expect(t.inicioMs).toBe(r[i - 1]!.finMs); // contiguous slots
    }
  }
  if (r.length > 0) expect(r.at(-1)!.finMs).toBe(duracionMs); // the last word holds to the end
  return r;
}

describe('calcularTiemposPalabras', () => {
  it('gives equal slots to words of equal length (even spacing)', () => {
    const r = invariantes('uno dos tre cua', 4150, REGLAS_TIEMPOS); // window = 4150 - 150 - 500 = 3500, 4 words of 3 chars
    expect(r.map((t) => t.inicioMs)).toEqual([150, 150 + 875, 150 + 1750, 150 + 2625]);
    expect(r.slice(0, 3).map((t) => t.finMs - t.inicioMs)).toEqual([875, 875, 875]);
    expect(r[3]).toMatchObject({ inicioMs: 2775, finMs: 4150 }); // the last holds through the final hold
  });

  it('gives longer words more time (reading speed follows length)', () => {
    const r = invariantes('a internacionalizacion', 3000);
    const corta = r[0]!.finMs - r[0]!.inicioMs;
    const larga = r[1]!.finMs - r[1]!.inicioMs;
    expect(corta).toBeGreaterThanOrEqual(REGLAS_TIEMPOS.minimoPorPalabraMs);
    expect(larga).toBeGreaterThan(corta);
  });

  it('one word starts at the lead-in and holds to the end of the scene', () => {
    expect(calcularTiemposPalabras('Hola', 2000)).toEqual([{ palabra: 'Hola', inicioMs: 150, finMs: 2000 }]);
    // 400 ms: 220 ms are left after the 180 ms minimum, shared by lead-in and hold in proportion (150 : 500).
    expect(calcularTiemposPalabras('Hola', 400)).toEqual([{ palabra: 'Hola', inicioMs: 50, finMs: 400 }]);
    expect(calcularTiemposPalabras('Hola', 1)).toEqual([{ palabra: 'Hola', inicioMs: 0, finMs: 1 }]);
  });

  it('a very short scene: the lead-in and the hold shrink first, every word keeps its minimum', () => {
    // 3 words x 180 = 540 ms; the scene lasts 700 ms, so only 160 ms are left for lead-in and hold together.
    const r = invariantes('uno dos tres', 700);
    expect(r.every((t, i) => i === r.length - 1 || t.finMs - t.inicioMs >= REGLAS_TIEMPOS.minimoPorPalabraMs)).toBe(true);
    expect(r[0]!.inicioMs).toBeLessThan(REGLAS_TIEMPOS.entradaMs);
  });

  it('a scene too short for the minimum lowers the minimum evenly; the lead-in and the hold are gone', () => {
    const r = invariantes('uno dos tres cuatro cinco', 300); // 5 words, 60 ms each at most
    expect(r[0]!.inicioMs).toBe(0);
    expect(Math.max(...r.map((t) => t.finMs - t.inicioMs))).toBeLessThanOrEqual(120);
    expect(r).toHaveLength(5);
  });

  it('refuses a scene with less than 1 ms per word, and invalid durations or rules', () => {
    expect(() => calcularTiemposPalabras('a b c d e', 4)).toThrow(TiemposInvalidosError);
    for (const d of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => calcularTiemposPalabras('hola', d), String(d)).toThrow(TiemposInvalidosError);
    }
    for (const reglas of [
      { ...REGLAS_TIEMPOS, minimoPorPalabraMs: 0 },
      { ...REGLAS_TIEMPOS, entradaMs: -1 },
      { ...REGLAS_TIEMPOS, retencionFinalMinMs: 1.5 },
    ]) {
      expect(() => calcularTiemposPalabras('hola', 2000, reglas)).toThrow(expect.objectContaining({ razon: 'reglas_invalidas' }));
    }
  });

  it('a very long scene keeps the lead-in and the hold and spreads the rest by length', () => {
    const r = invariantes('Cada mañana tostamos el café en casa', 30_000);
    expect(r[0]!.inicioMs).toBe(150);
    const ultimo = r.at(-1)!;
    expect(30_000 - ultimo.inicioMs).toBeGreaterThanOrEqual(REGLAS_TIEMPOS.retencionFinalMinMs); // the final hold
  });

  it('keeps punctuation attached to its word and the text untouched otherwise', () => {
    const r = invariantes('¡Hola, mundo! ¿Qué tal...?', 5000);
    expect(r.map((t) => t.palabra)).toEqual(['¡Hola,', 'mundo!', '¿Qué', 'tal...?']);
  });

  it('counts a letter with an accent as one character, however it is encoded (NFC or NFD)', () => {
    const nfc = calcularTiemposPalabras('niño canción', 3000);
    const nfd = calcularTiemposPalabras('niño canción'.normalize('NFD'), 3000);
    expect(nfd).toEqual(nfc);
    expect(nfc.map((t) => t.palabra)).toEqual(['niño', 'canción']);
  });

  it('treats any run of spaces, tabs and line breaks as one separator, and an empty text as no words', () => {
    expect(calcularTiemposPalabras('  uno \t\n  dos\r\n\r\ntres  ', 3000)).toEqual(calcularTiemposPalabras('uno dos tres', 3000));
    for (const vacio of ['', '   ', '\n\t ', ' ']) expect(calcularTiemposPalabras(vacio, 2000)).toEqual([]);
  });

  it('every word keeps at least the minimum when the scene is long enough for all of them', () => {
    const r = invariantes('a b c d e f g h i j', 4000);
    for (const t of r.slice(0, -1)) expect(t.finMs - t.inicioMs).toBeGreaterThanOrEqual(REGLAS_TIEMPOS.minimoPorPalabraMs);
  });

  it('does not change its input', () => {
    const reglas = { ...REGLAS_TIEMPOS };
    calcularTiemposPalabras('uno dos tres', 3000, reglas);
    expect(reglas).toEqual(REGLAS_TIEMPOS);
  });

  it('holds the invariants on 2,000 random cases (seeded)', () => {
    let seed = 20261022;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const letras = 'abcdeñáéíóúü¡!?,.';
    for (let caso = 0; caso < 2000; caso++) {
      const n = 1 + Math.floor(rnd() * 14);
      const texto = Array.from({ length: n }, () => Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => letras[Math.floor(rnd() * letras.length)]).join('')).join(rnd() < 0.2 ? '\n' : ' ');
      const duracion = n + Math.floor(rnd() * 12_000); // always at least 1 ms per word
      const reglas = rnd() < 0.5 ? undefined : { entradaMs: Math.floor(rnd() * 400), retencionFinalMinMs: Math.floor(rnd() * 900), minimoPorPalabraMs: 1 + Math.floor(rnd() * 300) };
      invariantes(texto, duracion, reglas);
    }
  });

  it('with no lead-in, no hold and a 1 ms minimum the slots follow the weights only', () => {
    const r = calcularTiemposPalabras('aa bbbb', 600, SIN_ENTRADA);
    expect(r.map((t) => t.finMs - t.inicioMs)).toEqual([200, 400]);
  });
});
