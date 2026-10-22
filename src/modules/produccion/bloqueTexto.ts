// The geometry shared by the static text overlay (7a/7b) and the animated templates (7c). PURE and free of
// any canvas or image library, so pure code and tests can use it without loading native modules.

/** The text block takes at most this share of the safe zone's height (a house value, VERIFICAR). */
export const ALTO_MAXIMO_DEL_TEXTO = 0.45;
/** Space around the text block inside the scrim, as a share of the font size. */
export const RELLENO = 0.6;
/** The canvas width the house sizes are written for. */
export const ANCHO_REFERENCIA = 1080;
export const MAX_LINEAS = 8;

/**
 * Where the text block and its scrim band go: the block sits at the bottom of the safe zone and the
 * band is full width around it.
 */
export function posicionDelBloque(
  zona: { y: number; alto: number },
  altoCanvas: number,
  layout: { tamano: number; altoBloque: number },
): { bloqueArriba: number; bandaArriba: number; bandaAbajo: number } {
  const relleno = layout.tamano * RELLENO;
  const bloqueAbajo = zona.y + zona.alto;
  const bloqueArriba = bloqueAbajo - layout.altoBloque;
  return {
    bloqueArriba,
    bandaArriba: Math.max(0, bloqueArriba - relleno),
    bandaAbajo: Math.min(altoCanvas, bloqueAbajo + relleno),
  };
}
