export { DIMENSIONES, DimensionNoSoportadaError, dimensionDe } from './dimensiones.js';
export type { Dimension } from './dimensiones.js';
export { InvalidSizeError, PieceHashInputError, SourceTooSmallError, TextDoesNotFitError } from './errors.js';
export type { PieceHashInputReason, TextDoesNotFitReason } from './errors.js';
export { computePieceHash, computePieceHashHex, HASH_VERSION } from './pieceHash.js';
export type { PieceHashInput } from './pieceHash.js';
export { computeCoverCrop, MAX_UPSCALE } from './crop.js';
export type { CoverCrop, Size } from './crop.js';
export { zonaSegura } from './safeArea.js';
export type { Rect } from './safeArea.js';
export { INTERLINEADO, layoutText, PASO, TAMANO_MAX, TAMANO_MIN } from './textLayout.js';
export type { LayoutTextInput, Medir, TextLayout } from './textLayout.js';
export {
  CONTRASTE_MINIMO,
  contraste,
  contrastePeorCaso,
  elegirColores,
  luminanciaRelativa,
  mezclar,
  parseHex,
  SCRIM_ALFA,
  SCRIM_RESPALDO,
  TEXTO_RESPALDO,
  toHex,
} from './colors.js';
export type { ColoresSlide, Rgb } from './colors.js';
export { ImageDecodeError, UnsupportedGlyphsError } from './errors.js';
export type { ImageDecodeReason } from './errors.js';
export {
  assertGlifosSoportados,
  COBERTURA_INTER_LATIN,
  contarGlifosNoSoportados,
  directorioDeFuentes,
  esTextoSoportado,
  FUENTE_POR_DEFECTO,
  registrarFuentes,
} from './fonts.js';
export { JPEG_CALIDAD, MAX_PIXELES_ORIGEN, renderSlide } from './renderer.js';
export type { LayoutSpec, RenderedSlide, SlideSpec } from './renderer.js';
export {
  BriefConFaltantesError,
  FormatoNoSoportadoError,
  FuentesMuyPequenasError,
  ProduccionEstadoInvalidoError,
  ProduccionExistenteError,
  ProduccionHechoVencidoError,
  ProduccionMediaNoUsableError,
  ProduccionObsoletaError,
  SinBriefError,
} from './errors.js';
export { getProduccionActual, listProduccionVersions } from './produccionRepository.js';
export type { ArchivoView, ProduccionReadOptions, ProduccionView } from './produccionRepository.js';
export { producirPieza } from './produccionService.js';
export type { PiezaProducida, ProducirOptions, ProduccionDeps } from './produccionService.js';
