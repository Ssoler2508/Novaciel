import { createCanvas, ImageData, type SKRSContext2D } from '@napi-rs/canvas';
import sharp, { type Metadata } from 'sharp';
import { detectTypeFromHeader } from '../../lib/media/validateMedia.js';
import type { Formato, Red } from '../planificador/types.js';
import { elegirColores, type ColoresSlide } from './colors.js';
import { computeCoverCrop, type CoverCrop } from './crop.js';
import { dimensionDe } from './dimensiones.js';
import { ImageDecodeError } from './errors.js';
import { assertGlifosSoportados, FUENTE_POR_DEFECTO, registrarFuentes } from './fonts.js';
import { zonaSegura } from './safeArea.js';
import { INTERLINEADO, layoutText, TAMANO_MAX, TAMANO_MIN } from './textLayout.js';

// The slide renderer: a real photo plus the slide's text in, the final JPEG out. REAL MEDIA ONLY: it
// crops, resizes, re-encodes, lays a scrim over the photo and draws the text. It never generates,
// inpaints, extends or alters the content of a photo.
//
//   decode + EXIF orientation + crop + resize   (sharp)
//   scrim + text with the bundled font          (@napi-rs/canvas)
//   JPEG quality 90, 4:4:4, sRGB, no metadata   (sharp)
//
// Nothing leaves this function until the very last step succeeds, so a failure never leaves a
// partial output. Errors are typed and carry reasons, sizes and counts, never the text.

/** JPEG quality of the final file (a house value, VERIFICAR). Chroma is 4:4:4 so text edges stay clean. */
export const JPEG_CALIDAD = 90;
/** Largest source accepted, in pixels (decompression-bomb guard). */
export const MAX_PIXELES_ORIGEN = 100_000_000;

const FORMATOS_ORIGEN = new Set(['jpeg', 'png', 'webp']);
/** The text block takes at most this share of the safe zone's height (a house value, VERIFICAR). */
const ALTO_MAXIMO_DEL_TEXTO = 0.45;
/** Space around the text block inside the scrim, as a share of the font size. */
const RELLENO = 0.6;
const ANCHO_REFERENCIA = 1080;
const MAX_LINEAS = 8;

export interface SlideSpec {
  /** The brief's rendered on-screen text. Empty or only whitespace: the photo is output with no scrim and no text. */
  texto: string;
}

export interface LayoutSpec {
  red: Red;
  formato: Formato;
  /** The profile's kit_visual (read only for its brand colors). */
  kitVisual: unknown;
  /** Font family to draw with. Defaults to the bundled Inter. */
  fuente?: string;
  /** Overrides of the target size from dimensiones (tests, special cases). */
  ancho?: number;
  alto?: number;
  /** Overrides MAX_UPSCALE. */
  maxUpscale?: number;
}

export interface RenderedSlide {
  jpeg: Buffer;
  ancho: number;
  alto: number;
  /** What was drawn, or null when the text was empty. */
  texto: { tamano: number; lineas: number; colores: ColoresSlide } | null;
}

/** sharp reports its pixel limit by message; any other failure to read the image is a decoding failure. */
function decodeFailure(error: unknown): ImageDecodeError {
  return new ImageDecodeError(error instanceof Error && /pixel limit/i.test(error.message) ? 'demasiados_pixeles' : 'no_se_pudo_decodificar');
}

function isOrientationSwapped(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

/** Steps 1 and 2: what the source is, checked from its real content, and its size once upright. */
async function inspect(source: Buffer): Promise<{ ancho: number; alto: number }> {
  let meta: Metadata;
  try {
    meta = await sharp(source, { limitInputPixels: MAX_PIXELES_ORIGEN }).metadata();
  } catch (error) {
    throw decodeFailure(error);
  }
  // Only still JPEG, PNG and WebP, and the header agrees with the decoder (never SVG, GIF, TIFF, HEIC...).
  const header = detectTypeFromHeader(source.subarray(0, 16));
  if (!meta.format || !FORMATOS_ORIGEN.has(meta.format) || (header !== 'jpeg' && header !== 'png' && header !== 'webp') || header !== meta.format) {
    throw new ImageDecodeError('formato_no_soportado');
  }
  if ((meta.pages ?? 1) > 1) throw new ImageDecodeError('animada');
  if (!meta.width || !meta.height) throw new ImageDecodeError('no_se_pudo_decodificar');
  if (meta.width * meta.height > MAX_PIXELES_ORIGEN) throw new ImageDecodeError('demasiados_pixeles');
  return isOrientationSwapped(meta.orientation) ? { ancho: meta.height, alto: meta.width } : { ancho: meta.width, alto: meta.height };
}

/** Step 3: upright, cropped and resized pixels (RGBA, sRGB). */
async function pixels(source: Buffer, crop: CoverCrop, ancho: number, alto: number): Promise<Buffer> {
  try {
    const { data } = await sharp(source, { limitInputPixels: MAX_PIXELES_ORIGEN })
      .rotate() // applies the EXIF orientation first, so the crop below is in upright coordinates
      .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
      .resize(ancho, alto, { fit: 'fill', kernel: 'lanczos3' })
      .flatten({ background: '#ffffff' }) // a transparent PNG is flattened on white
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data;
  } catch (error) {
    throw decodeFailure(error);
  }
}

export interface TextoSobreLienzo {
  ancho: number;
  alto: number;
  formato: Formato;
  /** Already trimmed and not empty. */
  texto: string;
  /** The profile's kit_visual (read only for its brand colors). */
  kitVisual: unknown;
  /** Font family to draw with. Defaults to the bundled Inter. */
  fuente?: string;
}

/**
 * Draws the scrim and the text of one slide or reel scene on a canvas that already holds the
 * background: the scrim is a translucent full-width band, the text is laid out inside the safe zone
 * and never cut. The same code draws the text over a photo (renderSlide) and over a transparent
 * canvas (the overlay of a reel). Throws TextDoesNotFitError or UnsupportedGlyphsError.
 */
export function dibujarTexto(ctx: SKRSContext2D, spec: TextoSobreLienzo): NonNullable<RenderedSlide['texto']> {
  const { ancho, alto, texto } = spec;
  const fuente = spec.fuente ?? FUENTE_POR_DEFECTO;
  assertGlifosSoportados(texto);
  registrarFuentes();

  const k = ancho / ANCHO_REFERENCIA;
  const zona = zonaSegura(ancho, alto, spec.formato);
  const medir = (linea: string, tamano: number) => {
    ctx.font = `700 ${tamano}px "${fuente}"`;
    return ctx.measureText(linea).width;
  };
  const layout = layoutText({
    texto,
    maxAncho: zona.ancho,
    maxAlto: zona.alto * ALTO_MAXIMO_DEL_TEXTO,
    medir,
    tamanoMax: TAMANO_MAX * k,
    tamanoMin: TAMANO_MIN * k,
    paso: 2 * k,
    interlineado: INTERLINEADO,
    maxLineas: MAX_LINEAS,
  });
  const colores = elegirColores(spec.kitVisual);

  // The text block sits at the bottom of the safe zone; the scrim is a full-width band around it.
  const relleno = layout.tamano * RELLENO;
  const bloqueAbajo = zona.y + zona.alto;
  const bloqueArriba = bloqueAbajo - layout.altoBloque;
  const bandaArriba = Math.max(0, bloqueArriba - relleno);
  const bandaAbajo = Math.min(alto, bloqueAbajo + relleno);
  ctx.globalAlpha = colores.alfa;
  ctx.fillStyle = colores.scrim;
  ctx.fillRect(0, bandaArriba, ancho, bandaAbajo - bandaArriba);
  ctx.globalAlpha = 1;

  ctx.fillStyle = colores.texto;
  ctx.font = `700 ${layout.tamano}px "${fuente}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  layout.lineas.forEach((linea, i) => {
    ctx.fillText(linea, ancho / 2, bloqueArriba + (i + 0.5) * layout.interlineadoPx);
  });
  return { tamano: layout.tamano, lineas: layout.lineas.length, colores };
}

/**
 * The final JPEG of one slide. Throws SourceTooSmallError, TextDoesNotFitError, UnsupportedGlyphsError
 * or ImageDecodeError; never returns a partial result.
 */
export async function renderSlide(source: Buffer, slide: SlideSpec, layoutSpec: LayoutSpec): Promise<RenderedSlide> {
  const dimension = layoutSpec.ancho !== undefined && layoutSpec.alto !== undefined ? { ancho: layoutSpec.ancho, alto: layoutSpec.alto } : dimensionDe(layoutSpec.red, layoutSpec.formato);
  const { ancho, alto } = dimension;
  const objetivo = { ancho, alto }; // just the size: the errors carry it
  const fuente = layoutSpec.fuente ?? FUENTE_POR_DEFECTO;
  const texto = slide.texto.trim();

  // Cheap refusals first, before any pixel is decoded.
  const orientada = await inspect(source);
  const crop = computeCoverCrop(orientada, objetivo, layoutSpec.maxUpscale !== undefined ? { maxUpscale: layoutSpec.maxUpscale } : {});
  assertGlifosSoportados(texto);

  const base = await pixels(source, crop, ancho, alto);

  let dibujado: RenderedSlide['texto'] = null;
  let rgba = base;
  if (texto !== '') {
    registrarFuentes();
    const canvas = createCanvas(ancho, alto);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(base.buffer, base.byteOffset, base.length), ancho, alto), 0, 0);
    dibujado = dibujarTexto(ctx, { ancho, alto, formato: layoutSpec.formato, texto, kitVisual: layoutSpec.kitVisual, fuente });

    const dibujada = ctx.getImageData(0, 0, ancho, alto);
    rgba = Buffer.from(dibujada.data.buffer, dibujada.data.byteOffset, dibujada.data.length);
  }

  // sharp drops every kind of metadata (EXIF, XMP, IPTC, ICC) unless asked to keep it, and this code never asks.
  const jpeg = await sharp(rgba, { raw: { width: ancho, height: alto, channels: 4 } })
    .removeAlpha()
    .toColourspace('srgb')
    .jpeg({ quality: JPEG_CALIDAD, chromaSubsampling: '4:4:4', progressive: false, mozjpeg: false, optimiseCoding: true })
    .toBuffer();
  return { jpeg, ancho, alto, texto: dibujado };
}
