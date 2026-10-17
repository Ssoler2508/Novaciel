import type { Formato } from '../planificador/types.js';
import { InvalidSizeError } from './errors.js';

// The safe zone: where text may go (spec 9.4: no text in the bands that the platform buttons cover).
// The spec gives no numbers, so these are HOUSE values, VERIFICAR against each network, written for a
// 1080-pixel-wide canvas and scaled to the real width.

export interface Rect {
  x: number;
  y: number;
  ancho: number;
  alto: number;
}

interface Margenes {
  lados: number;
  arriba: number;
  abajo: number;
}

const REFERENCIA = 1080;
const MARGENES: Record<Formato, Margenes> = {
  // 4:5 portrait slides: only a comfortable margin; the feed shows the whole slide.
  carrusel: { lados: 80, arriba: 100, abajo: 120 },
  post: { lados: 80, arriba: 100, abajo: 120 },
  // Full-screen vertical (1080 x 1920): the top bar and the reply/like bar cover roughly 250 and 340 px.
  historia: { lados: 64, arriba: 250, abajo: 340 },
  reel: { lados: 64, arriba: 250, abajo: 340 },
};

/** The rectangle of an `ancho` x `alto` canvas where text may be drawn. */
export function zonaSegura(ancho: number, alto: number, formato: Formato): Rect {
  if (!Number.isFinite(ancho) || !Number.isFinite(alto) || ancho <= 0 || alto <= 0) throw new InvalidSizeError('canvas');
  const k = ancho / REFERENCIA;
  const m = MARGENES[formato];
  const rect = {
    x: Math.round(m.lados * k),
    y: Math.round(m.arriba * k),
    ancho: Math.round(ancho - 2 * m.lados * k),
    alto: Math.round(alto - (m.arriba + m.abajo) * k),
  };
  if (rect.ancho <= 0 || rect.alto <= 0) throw new InvalidSizeError('canvas');
  return rect;
}
