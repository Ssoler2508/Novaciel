import { InvalidSizeError, SourceTooSmallError } from './errors.js';

// Crop math for the slides: cover-fit a source of any size and orientation into the target size,
// centered. Pure. The source size is the size AFTER the EXIF orientation is applied (the renderer
// passes the oriented size). A focal point or face-aware crop can come later (known debt).

/**
 * How much a source may be enlarged to cover the target: a house value, VERIFICAR. Beyond 1.5 times
 * the slide is visibly soft on a phone, so production refuses instead of upscaling into a blurry slide.
 */
export const MAX_UPSCALE = 1.5;

export interface Size {
  ancho: number;
  alto: number;
}

export interface CoverCrop {
  /** The region of the SOURCE to keep, in whole pixels, always inside it. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** target pixels per source pixel (above 1 means the source is enlarged). */
  scale: number;
}

function assertSize(size: Size, campo: string): void {
  if (!Number.isFinite(size.ancho) || !Number.isFinite(size.alto) || size.ancho <= 0 || size.alto <= 0 || !Number.isInteger(size.ancho) || !Number.isInteger(size.alto)) {
    throw new InvalidSizeError(campo);
  }
}

/**
 * The centered region of `source` that, resized to `target`, covers it with no bars. Throws
 * InvalidSizeError for a size that is not a positive whole number and SourceTooSmallError when the
 * source would have to be enlarged by more than `maxUpscale` (MAX_UPSCALE by default).
 */
export function computeCoverCrop(source: Size, target: Size, options: { maxUpscale?: number } = {}): CoverCrop {
  assertSize(source, 'source');
  assertSize(target, 'target');
  const maxUpscale = options.maxUpscale ?? MAX_UPSCALE;

  const scale = Math.max(target.ancho / source.ancho, target.alto / source.alto);
  if (scale > maxUpscale) throw new SourceTooSmallError(scale, source, target);

  // The part of the source that maps onto the target: one dimension is whole, the other is cut.
  const width = Math.min(source.ancho, Math.max(1, Math.round(target.ancho / scale)));
  const height = Math.min(source.alto, Math.max(1, Math.round(target.alto / scale)));
  const left = Math.floor((source.ancho - width) / 2);
  const top = Math.floor((source.alto - height) / 2);
  return { left, top, width, height, scale };
}
