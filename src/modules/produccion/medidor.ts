import { createCanvas } from '@napi-rs/canvas';
import { FUENTE_POR_DEFECTO, registrarFuentes } from './fonts.js';
import type { Medir } from './textLayout.js';

/**
 * The measure function of the bundled font (Inter Bold) on a real canvas, for the layout of the animated
 * text. The same font file, the same engine and the same call the static overlay (7a/7b) measures with.
 */
export function crearMedidor(fuente: string = FUENTE_POR_DEFECTO): Medir {
  registrarFuentes();
  const ctx = createCanvas(16, 16).getContext('2d');
  return (texto, tamano) => {
    ctx.font = `700 ${tamano}px "${fuente}"`;
    return ctx.measureText(texto).width;
  };
}
