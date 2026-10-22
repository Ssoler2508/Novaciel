import { TiemposInvalidosError } from './errors.js';

// Word-by-word timing of a scene's on-screen text (Step 7c). COMPUTED, not transcribed: reels have no
// voice yet, so "word by word" means the scene's own text appearing over the scene's duration. In 7d the
// voice provider will feed the same `{ palabra, inicioMs, finMs }` shape with real timings. PURE.
//
// The rule (ADR-06 §6):
//   - words are the whitespace-separated tokens of the NFC-normalized text; punctuation stays attached;
//   - each word weighs its number of characters (code points), so reading time follows its length;
//   - the speaking window is the scene minus a lead-in and a final hold; every word gets a minimum time
//     plus a share of the rest in proportion to its weight, and the slots add up to the window exactly;
//   - when the window is too small the lead-in and the hold shrink first, then the minimum is lowered;
//   - the slots are contiguous; the LAST word holds until the end of the scene.

export interface ReglasTiempos {
  /** Time before the first word appears. */
  entradaMs: number;
  /** The text stays complete on screen at least this long at the end (it shrinks only when the scene is short). */
  retencionFinalMinMs: number;
  /** Least time a word gets before the next one starts. */
  minimoPorPalabraMs: number;
}

/** House values (VERIFICAR with real reels). */
export const REGLAS_TIEMPOS: ReglasTiempos = { entradaMs: 150, retencionFinalMinMs: 500, minimoPorPalabraMs: 180 };

export interface TiempoPalabra {
  palabra: string;
  /** Integer ms from the start of the scene. */
  inicioMs: number;
  /** Integer ms: the start of the next word, or `duracionMs` for the last one. */
  finMs: number;
}

/** The words of a text: NFC, split on any whitespace, no empty tokens. */
export function palabrasDe(texto: string): string[] {
  return texto
    .normalize('NFC')
    .split(/\s+/u)
    .filter((palabra) => palabra !== '');
}

const pesoDe = (palabra: string): number => Math.max(1, [...palabra].length);

function checkReglas(reglas: ReglasTiempos): void {
  const entero = (v: number) => Number.isInteger(v) && v >= 0;
  if (!entero(reglas.entradaMs) || !entero(reglas.retencionFinalMinMs) || !Number.isInteger(reglas.minimoPorPalabraMs) || reglas.minimoPorPalabraMs < 1) {
    throw new TiemposInvalidosError('reglas_invalidas');
  }
}

/**
 * The time of each word of `texto` inside a scene of `duracionMs`. Empty text gives an empty list.
 * Throws TiemposInvalidosError for a duration that is not a positive integer, rules that are not valid,
 * or a scene with less than 1 ms per word.
 */
export function calcularTiemposPalabras(texto: string, duracionMs: number, reglas: ReglasTiempos = REGLAS_TIEMPOS): TiempoPalabra[] {
  if (!Number.isInteger(duracionMs) || duracionMs < 1) throw new TiemposInvalidosError('duracion_invalida');
  checkReglas(reglas);
  const palabras = palabrasDe(texto);
  const n = palabras.length;
  if (n === 0) return [];
  if (duracionMs < n) throw new TiemposInvalidosError('duracion_insuficiente');

  let minimo = reglas.minimoPorPalabraMs;
  let entrada = reglas.entradaMs;
  let retencion = reglas.retencionFinalMinMs;
  if (duracionMs - entrada - retencion < n * minimo) {
    const sobra = duracionMs - n * minimo;
    if (sobra >= 0) {
      // The lead-in and the hold shrink together, in proportion, so that every word keeps its minimum.
      const total = entrada + retencion;
      entrada = total === 0 ? 0 : Math.floor((sobra * entrada) / total);
      retencion = sobra - entrada;
    } else {
      // Not even the minimum fits: it is lowered evenly, and nothing is left for lead-in or hold.
      minimo = Math.floor(duracionMs / n);
      entrada = 0;
      retencion = 0;
    }
  }

  const ventana = duracionMs - entrada - retencion; // at least n * minimo
  const extra = ventana - n * minimo;
  const pesos = palabras.map(pesoDe);
  const pesoTotal = pesos.reduce((a, b) => a + b, 0);

  // Boundaries by cumulative sums, so the integer rounding never drifts and the slots add up to the window.
  const limite = (k: number, pesoAcumulado: number) => entrada + k * minimo + Math.floor((extra * pesoAcumulado) / pesoTotal);
  const salida: TiempoPalabra[] = [];
  let acumulado = 0;
  for (let i = 0; i < n; i++) {
    const inicioMs = limite(i, acumulado);
    acumulado += pesos[i]!;
    const finMs = i === n - 1 ? duracionMs : limite(i + 1, acumulado);
    salida.push({ palabra: palabras[i]!, inicioMs, finMs });
  }
  return salida;
}
