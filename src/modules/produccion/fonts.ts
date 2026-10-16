import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts } from '@napi-rs/canvas';
import { UnsupportedGlyphsError } from './errors.js';

// The bundled font (Inter, SIL OFL 1.1: assets/fonts/), its glyph coverage and its registration with
// the canvas. The coverage table is the single place that says which characters a slide may carry,
// so the renderer (last guard) and the brief schema (upstream) use the same one.

/** The family name the renderer draws with by default. */
export const FUENTE_POR_DEFECTO = 'Inter';

const ARCHIVOS = [
  { archivo: 'inter-latin-400-normal.woff2', peso: 400 },
  { archivo: 'inter-latin-700-normal.woff2', peso: 700 },
] as const;

/**
 * Code points the bundled Inter Latin subset has (its unicode-range in @fontsource/inter 5.3.0):
 * Spanish, English, Portuguese, French and Italian text, the euro sign and general punctuation. No
 * emoji and no other scripts.
 */
export const COBERTURA_INTER_LATIN: readonly (readonly [number, number])[] = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];

function cubierto(codePoint: number): boolean {
  return COBERTURA_INTER_LATIN.some(([desde, hasta]) => codePoint >= desde && codePoint <= hasta);
}

/** How many characters (code points) of `texto` the bundled font cannot draw. */
export function contarGlifosNoSoportados(texto: string): number {
  let cantidad = 0;
  for (const caracter of texto) if (!cubierto(caracter.codePointAt(0)!)) cantidad++;
  return cantidad;
}

/** True when every character of `texto` can be drawn with the bundled font. */
export function esTextoSoportado(texto: string): boolean {
  return contarGlifosNoSoportados(texto) === 0;
}

/** Throws UnsupportedGlyphsError (a count, never the text) when `texto` has characters the font lacks. */
export function assertGlifosSoportados(texto: string): void {
  const cantidad = contarGlifosNoSoportados(texto);
  if (cantidad > 0) throw new UnsupportedGlyphsError(cantidad);
}

/**
 * The folder with the bundled fonts. Found by walking up from this file until assets/fonts/OFL.txt
 * exists, so it works from the sources (tsx, vitest) and from the compiled dist/src alike.
 */
export function directorioDeFuentes(): string {
  let carpeta = path.dirname(fileURLToPath(import.meta.url));
  for (let nivel = 0; nivel < 8; nivel++) {
    const candidata = path.join(carpeta, 'assets', 'fonts');
    if (existsSync(path.join(candidata, 'OFL.txt'))) return candidata;
    const padre = path.dirname(carpeta);
    if (padre === carpeta) break;
    carpeta = padre;
  }
  throw new Error('The bundled fonts folder (assets/fonts) was not found');
}

let registradas = false;

/** Registers Inter Regular and Bold with the canvas under the family "Inter". Safe to call many times. */
export function registrarFuentes(): void {
  if (registradas) return;
  const carpeta = directorioDeFuentes();
  for (const { archivo } of ARCHIVOS) {
    if (!GlobalFonts.registerFromPath(path.join(carpeta, archivo), FUENTE_POR_DEFECTO)) {
      throw new Error(`The bundled font ${archivo} could not be registered`);
    }
  }
  registradas = true;
}
