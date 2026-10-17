import { UnsupportedGlyphsError } from './errors.js';

// Which characters the bundled font (Inter, Latin subset; assets/fonts/) can draw. PURE: no canvas,
// no files. It lives apart from fonts.ts so that code that only needs the check (the brief schema of
// Step 6) does not load the native canvas module; fonts.ts re-exports everything here, so the
// renderer (the last guard) and the schema (upstream) use the SAME table.

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
