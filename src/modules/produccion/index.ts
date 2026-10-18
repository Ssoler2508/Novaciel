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
export { assertProducible } from './produccionService.js';
export {
  createPgBossProduccionQueue,
  ejecutarJobProducirPieza,
  ejecutarJobProducirPlan,
  PRODUCIR_PIEZA_QUEUE,
  PRODUCIR_PLAN_QUEUE,
  registerProduccionJobs,
  singletonKeyPieza,
  singletonKeyPlan,
} from './produccionJobs.js';
export type {
  FuentesPequenas,
  ProducirPiezaEnPlan,
  ProducirPiezaOutput,
  ProducirPiezaPayload,
  ProducirPlanOutput,
  ProducirPlanPayload,
  ProduccionJobInfo,
  ProduccionQueue,
} from './produccionJobs.js';
export { registerProduccionRoutes } from './produccionRoutes.js';
export type { ProduccionRoutesOptions } from './produccionRoutes.js';
export { toProduccionPublica } from './produccionView.js';
export type { ArchivoPublico, ProduccionPublica } from './produccionView.js';
export {
  DuracionTotalFueraDeRangoError,
  EscenaMasLargaQueLaFuenteError,
  EscenaSinVideoError,
  HdrNoSoportadoError,
  MarcasFueraDeRangoError,
  RutaInvalidaError,
  TimelineInvalidoError,
} from './errors.js';
export type { RutaInvalidaReason, TimelineInvalidoReason } from './errors.js';
export { buildReelTimeline, REEL_ALTO, REEL_ANCHO, REEL_FPS } from './reelTimeline.js';
export type { ReelGuionInput, ReelSegment, ReelSourceMeta, ReelTimeline } from './reelTimeline.js';
export { buildFfmpegArgs, DEFAULT_REEL_OUTPUT } from './reelFfmpegArgs.js';
export type { ReelOutputSpec, ReelPaths } from './reelFfmpegArgs.js';
export { FuenteDeVideoIlegibleError, SalidaInvalidaError } from './errors.js';
export type { SalidaInvalidaRazon } from './errors.js';
export { renderReelOverlay } from './reelOverlay.js';
export type { ReelOverlay } from './reelOverlay.js';
export { renderReel } from './reelRenderer.js';
export type { ReelRenderDeps, ReelRenderInput, ReelRenderResult } from './reelRenderer.js';
export { ETIQUETAS_FORMATO_PERMITIDAS, ETIQUETAS_STREAM_PERMITIDAS, MAX_REEL_BYTES, TOLERANCIA_DURACION_MS, verifyReelOutput } from './reelVerify.js';
export { dibujarTexto } from './renderer.js';
export type { TextoSobreLienzo } from './renderer.js';
