import { InvalidSizeError, TextDoesNotFitError } from './errors.js';

// Text layout for a slide: wrap the on-screen text into a box, shrinking the font size until it
// fits. Pure: the width of a text is measured by a function passed in (the renderer gives it the
// real canvas; tests give it a fake), so no canvas is needed here. Text is NEVER cut: no mid-word
// breaks and no ellipsis. If it does not fit even at the smallest size, it is refused.

/** Measured width of `texto` drawn at `tamano` pixels. */
export type Medir = (texto: string, tamano: number) => number;

export interface LayoutTextInput {
  texto: string;
  maxAncho: number;
  maxAlto: number;
  medir: Medir;
  /** Largest and smallest font sizes in pixels (house defaults, VERIFICAR) and the step between tries. */
  tamanoMax?: number;
  tamanoMin?: number;
  paso?: number;
  /** Line height as a multiple of the font size. */
  interlineado?: number;
  maxLineas?: number;
}

export interface TextLayout {
  tamano: number;
  lineas: string[];
  interlineadoPx: number;
  /** Height of the whole block: lines x interlineadoPx. */
  altoBloque: number;
}

export const TAMANO_MAX = 72;
export const TAMANO_MIN = 36;
export const PASO = 2;
export const INTERLINEADO = 1.25;
const EPSILON = 1e-9;

function positive(value: number, campo: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new InvalidSizeError(campo);
  return value;
}

/** Hard line breaks are kept, spaces collapsed and ends trimmed; empty lines are dropped. */
function paragraphs(texto: string): string[][] {
  return texto
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/).filter((word) => word !== ''))
    .filter((words) => words.length > 0);
}

/** Greedy word wrap at one size. Null when a single word is wider than the box. */
function wrap(parrafos: string[][], tamano: number, maxAncho: number, medir: Medir): string[] | null {
  const lineas: string[] = [];
  for (const words of parrafos) {
    let linea = '';
    for (const word of words) {
      const candidata = linea === '' ? word : `${linea} ${word}`;
      if (medir(candidata, tamano) <= maxAncho + EPSILON) {
        linea = candidata;
      } else if (linea === '') {
        return null; // this word alone is too wide at this size
      } else {
        lineas.push(linea);
        if (medir(word, tamano) > maxAncho + EPSILON) return null;
        linea = word;
      }
    }
    lineas.push(linea);
  }
  return lineas;
}

/**
 * The largest font size (from tamanoMax down to tamanoMin) at which the text fits the box, with its
 * lines. Throws TextDoesNotFitError (a reason and counts, never the text) when it fits at none.
 */
export function layoutText(input: LayoutTextInput): TextLayout {
  const tamanoMax = positive(input.tamanoMax ?? TAMANO_MAX, 'tamanoMax');
  const tamanoMin = positive(input.tamanoMin ?? TAMANO_MIN, 'tamanoMin');
  const paso = positive(input.paso ?? PASO, 'paso');
  const interlineado = positive(input.interlineado ?? INTERLINEADO, 'interlineado');
  positive(input.maxAncho, 'maxAncho');
  positive(input.maxAlto, 'maxAlto');
  if (tamanoMin > tamanoMax) throw new InvalidSizeError('tamanoMin');
  if (input.maxLineas !== undefined) positive(input.maxLineas, 'maxLineas');

  const parrafos = paragraphs(input.texto);
  if (parrafos.length === 0) throw new TextDoesNotFitError('texto_vacio');

  // Sizes from the largest down, always ending with the smallest.
  const tamanos: number[] = [];
  for (let t = tamanoMax; t > tamanoMin + EPSILON; t -= paso) tamanos.push(t);
  tamanos.push(tamanoMin);

  let ultimo: string[] | null = null;
  for (const tamano of tamanos) {
    const lineas = wrap(parrafos, tamano, input.maxAncho, input.medir);
    ultimo = lineas;
    if (lineas === null) continue;
    const interlineadoPx = tamano * interlineado;
    const altoBloque = lineas.length * interlineadoPx;
    if (altoBloque <= input.maxAlto + EPSILON && (input.maxLineas === undefined || lineas.length <= input.maxLineas)) {
      return { tamano, lineas, interlineadoPx, altoBloque };
    }
  }

  // It fits at no size: say why, judged at the smallest size.
  if (ultimo === null) throw new TextDoesNotFitError('palabra_mas_ancha_que_la_caja', { tamanoMin });
  if (input.maxLineas !== undefined && ultimo.length > input.maxLineas) {
    throw new TextDoesNotFitError('demasiadas_lineas', { tamanoMin, lineas: ultimo.length });
  }
  throw new TextDoesNotFitError('no_cabe_en_el_alto', { tamanoMin, lineas: ultimo.length });
}
