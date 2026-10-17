// Colors of a slide: the text color and the scrim (the dark or light veil between the photo and the
// text), chosen from the brand's kit_visual with a WCAG contrast of at least 4.5:1, or a safe
// fallback. Pure.
//
// The scrim is drawn at a fixed opacity over a photo of unknown color, so the contrast is checked
// against the WORST CASE: the scrim blended over a pure black and over a pure white photo pixel; both
// must reach 4.5. That is stricter than a ratio against the solid scrim color. Blending is done in
// sRGB values, the way a canvas draws with an alpha.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** WCAG 2.x AA for normal text. */
export const CONTRASTE_MINIMO = 4.5;
/** Opacity of the scrim over the photo: a house value, VERIFICAR. */
export const SCRIM_ALFA = 0.78;
export const TEXTO_RESPALDO = '#ffffff';
export const SCRIM_RESPALDO = '#1a1a1a';

const NEGRO: Rgb = { r: 0, g: 0, b: 0 };
const BLANCO: Rgb = { r: 255, g: 255, b: 255 };

/** '#RGB' or '#RRGGBB' (any case) → Rgb; anything else → null. */
export function parseHex(value: unknown): Rgb | null {
  if (typeof value !== 'string') return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return { r: parseInt(short[1]! + short[1]!, 16), g: parseInt(short[2]! + short[2]!, 16), b: parseInt(short[3]! + short[3]!, 16) };
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (long) return { r: parseInt(long[1]!, 16), g: parseInt(long[2]!, 16), b: parseInt(long[3]!, 16) };
  return null;
}

export function toHex(color: Rgb): string {
  const part = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminanciaRelativa(color: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG contrast ratio between two colors, 1 to 21. */
export function contraste(a: Rgb, b: Rgb): number {
  const la = luminanciaRelativa(a);
  const lb = luminanciaRelativa(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `frente` drawn over `fondo` with opacity `alfa`. */
export function mezclar(frente: Rgb, fondo: Rgb, alfa: number): Rgb {
  const mix = (f: number, b: number) => alfa * f + (1 - alfa) * b;
  return { r: mix(frente.r, fondo.r), g: mix(frente.g, fondo.g), b: mix(frente.b, fondo.b) };
}

/** The lowest contrast of the text over the scrim, on a black and on a white photo pixel. */
export function contrastePeorCaso(texto: Rgb, scrim: Rgb, alfa: number = SCRIM_ALFA): number {
  return Math.min(contraste(texto, mezclar(scrim, NEGRO, alfa)), contraste(texto, mezclar(scrim, BLANCO, alfa)));
}

export interface ColoresSlide {
  /** '#rrggbb' */
  texto: string;
  /** '#rrggbb' */
  scrim: string;
  alfa: number;
  /** 'marca' when the pair comes from the kit, 'respaldo' when it is the fallback. */
  origen: 'marca' | 'respaldo';
  /** The worst-case contrast of the pair (always at least 4.5). */
  contraste: number;
}

/** The brand colors of the kit in order (principal, secundarios, acento), valid and without repeats. */
function coloresDeMarca(kitVisual: unknown): Rgb[] {
  const colores = (kitVisual as { colores?: unknown } | null | undefined)?.colores as
    | { principal?: unknown; secundarios?: unknown; acento?: unknown }
    | null
    | undefined;
  if (colores === null || typeof colores !== 'object') return [];
  const candidatos: unknown[] = [colores.principal, ...(Array.isArray(colores.secundarios) ? colores.secundarios : []), colores.acento];
  const vistos = new Set<string>();
  const out: Rgb[] = [];
  for (const candidato of candidatos) {
    const rgb = parseHex(candidato);
    if (!rgb) continue;
    const hex = toHex(rgb);
    if (vistos.has(hex)) continue;
    vistos.add(hex);
    out.push(rgb);
  }
  return out;
}

/**
 * The text and scrim colors for a slide. For each brand color as scrim (in kit order), the first text
 * color (the other brand colors, then white, then black) whose worst-case contrast is at least 4.5.
 * Without a usable pair it falls back to white text on a dark scrim.
 */
export function elegirColores(kitVisual: unknown): ColoresSlide {
  const marca = coloresDeMarca(kitVisual);
  for (const scrim of marca) {
    const textos = [...marca.filter((c) => toHex(c) !== toHex(scrim)), BLANCO, NEGRO];
    for (const texto of textos) {
      const ratio = contrastePeorCaso(texto, scrim);
      if (ratio >= CONTRASTE_MINIMO) return { texto: toHex(texto), scrim: toHex(scrim), alfa: SCRIM_ALFA, origen: 'marca', contraste: ratio };
    }
  }
  const respaldoTexto = parseHex(TEXTO_RESPALDO)!;
  const respaldoScrim = parseHex(SCRIM_RESPALDO)!;
  return {
    texto: TEXTO_RESPALDO,
    scrim: SCRIM_RESPALDO,
    alfa: SCRIM_ALFA,
    origen: 'respaldo',
    contraste: contrastePeorCaso(respaldoTexto, respaldoScrim),
  };
}
