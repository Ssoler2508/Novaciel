import { createCanvas } from '@napi-rs/canvas';
import type { ColoresSlide } from './colors.js';
import { registrarFuentes } from './fonts.js';
import { REEL_ALTO, REEL_ANCHO } from './reelTimeline.js';
import { dibujarTexto } from './renderer.js';

// The text overlay of one reel scene: a transparent PNG the size of the video, with the 7a scrim and
// text on it (same layout, colors, font and safe zone as a story or reel slide). FFmpeg only overlays
// this FILE; the text itself never goes near an FFmpeg argument. Throws what dibujarTexto throws:
// TextDoesNotFitError or UnsupportedGlyphsError.

export interface ReelOverlay {
  png: Buffer;
  ancho: number;
  alto: number;
  texto: { tamano: number; lineas: number; colores: ColoresSlide };
}

/** The overlay PNG for `texto`, or null when the text is empty or only whitespace (no overlay is drawn). */
export function renderReelOverlay(texto: string, kitVisual: unknown, fuente?: string): ReelOverlay | null {
  const limpio = texto.trim();
  if (limpio === '') return null;
  registrarFuentes();
  const canvas = createCanvas(REEL_ANCHO, REEL_ALTO);
  const ctx = canvas.getContext('2d');
  const dibujado = dibujarTexto(ctx, { ancho: REEL_ANCHO, alto: REEL_ALTO, formato: 'reel', texto: limpio, kitVisual, ...(fuente !== undefined ? { fuente } : {}) });
  return { png: canvas.toBuffer('image/png'), ancho: REEL_ANCHO, alto: REEL_ALTO, texto: dibujado };
}
