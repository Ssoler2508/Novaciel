// Typed errors of the pure production code. Messages name reasons, sizes and counts only: never the
// caption, the on-screen text or any other client content.

export type PieceHashInputReason =
  | 'sin_archivos'
  | 'hash_de_archivo_invalido'
  | 'textos_alternativos_distinto_de_archivos'
  | 'red_invalida'
  | 'texto_mal_formado';

/** The input of computePieceHash cannot be hashed (see docs/HASH_PIEZA_NP1.md). */
export class PieceHashInputError extends Error {
  constructor(readonly reason: PieceHashInputReason) {
    super(`The piece hash input is invalid: ${reason}`);
    this.name = 'PieceHashInputError';
  }
}

/** The source image is too small for the target: it would have to be enlarged by more than MAX_UPSCALE. */
export class SourceTooSmallError extends Error {
  constructor(
    readonly scale: number,
    readonly source: { ancho: number; alto: number },
    readonly target: { ancho: number; alto: number },
  ) {
    super(`The source ${source.ancho}x${source.alto} is too small for ${target.ancho}x${target.alto} (it would be enlarged ${scale.toFixed(2)} times)`);
    this.name = 'SourceTooSmallError';
  }
}

/** A size is not a positive finite number. */
export class InvalidSizeError extends Error {
  constructor(readonly campo: string) {
    super(`Invalid size: ${campo}`);
    this.name = 'InvalidSizeError';
  }
}

export type TextDoesNotFitReason = 'texto_vacio' | 'palabra_mas_ancha_que_la_caja' | 'no_cabe_en_el_alto' | 'demasiadas_lineas';

/** The text cannot be laid out in the box, even at the smallest size. It is never cut. */
export class TextDoesNotFitError extends Error {
  constructor(
    readonly reason: TextDoesNotFitReason,
    readonly detalle: { tamanoMin?: number; lineas?: number } = {},
  ) {
    super(`The text does not fit: ${reason}`);
    this.name = 'TextDoesNotFitError';
  }
}

export type ImageDecodeReason = 'no_se_pudo_decodificar' | 'formato_no_soportado' | 'animada' | 'demasiados_pixeles';

/** The source image cannot be used: it does not decode, it is not a still JPEG/PNG/WebP, or it is huge. No output exists. */
export class ImageDecodeError extends Error {
  constructor(readonly reason: ImageDecodeReason) {
    super(`The source image cannot be used: ${reason}`);
    this.name = 'ImageDecodeError';
  }
}

/** The text has characters the bundled font cannot draw. The text is never changed to hide them. */
export class UnsupportedGlyphsError extends Error {
  constructor(readonly cantidad: number) {
    super(`The text has ${cantidad} character(s) the bundled font cannot draw`);
    this.name = 'UnsupportedGlyphsError';
  }
}

/**
 * One or more sources are too small for their slide. Thrown by the production service after trying
 * EVERY slide, with the distinct media ids and the slide numbers involved (ids and numbers only).
 * It is a SourceTooSmallError, so `instanceof SourceTooSmallError` still holds.
 */
export class FuentesMuyPequenasError extends SourceTooSmallError {
  constructor(
    base: SourceTooSmallError,
    readonly mediaIds: readonly string[],
    readonly ordenes: readonly number[],
  ) {
    super(base.scale, base.source, base.target);
    this.name = 'FuentesMuyPequenasError';
    this.message = `${mediaIds.length} source image(s) are too small for their slide (slides ${ordenes.join(', ')})`;
  }
}

/** The piece is not in a state that can be produced (or re-produced). */
export class ProduccionEstadoInvalidoError extends Error {
  constructor(readonly estado: string) {
    super(`A piece in state ${estado} cannot be produced`);
    this.name = 'ProduccionEstadoInvalidoError';
  }
}

/** Only still-image formats are produced in 7a; video waits for 7b. */
export class FormatoNoSoportadoError extends Error {
  constructor(
    readonly red: string,
    readonly formato: string,
  ) {
    super(`The format ${formato} is not produced yet for ${red}`);
    this.name = 'FormatoNoSoportadoError';
  }
}

/** The piece has no current brief to produce from. */
export class SinBriefError extends Error {
  constructor() {
    super('The piece has no current brief');
    this.name = 'SinBriefError';
  }
}

/** The brief has slots without media (`faltante`): production refuses before changing anything. */
export class BriefConFaltantesError extends Error {
  constructor(readonly ordenes: readonly number[]) {
    super(`The brief has ${ordenes.length} slot(s) without media (slides ${ordenes.join(', ')})`);
    this.name = 'BriefConFaltantesError';
  }
}

/** The piece already has a current production and `reproducir` was not asked. */
export class ProduccionExistenteError extends Error {
  constructor(readonly version: number) {
    super(`The piece already has a current production (version ${version})`);
    this.name = 'ProduccionExistenteError';
  }
}

/** A fact the brief cites is not valid now or at the piece's instant (rule 2 at production time). */
export class ProduccionHechoVencidoError extends Error {
  constructor(readonly hechoIds: readonly string[]) {
    super(`${hechoIds.length} fact(s) cited by the brief are no longer valid`);
    this.name = 'ProduccionHechoVencidoError';
  }
}

/** A media item of the brief stopped being usable (rights, authorization, deleted). */
export class ProduccionMediaNoUsableError extends Error {
  constructor(readonly mediaIds: readonly string[]) {
    super(`${mediaIds.length} media item(s) of the brief are no longer usable`);
    this.name = 'ProduccionMediaNoUsableError';
  }
}

/** The piece, its brief or its productions changed while the files were being made: nothing is kept. */
export class ProduccionObsoletaError extends Error {
  constructor() {
    super('The piece changed while it was being produced; nothing was kept');
    this.name = 'ProduccionObsoletaError';
  }
}

// ---------------------------------------------------------------------------------------------
// Reels (Step 7b). Messages carry scene numbers, counts and times only: never on-screen text.

export type TimelineInvalidoReason = 'escenas_sin_orden' | 'tomas_distintas_de_escenas' | 'duracion_de_escena_invalida' | 'numero_de_escenas' | 'metadatos_invalidos';

/** The scenes of the brief cannot be turned into a timeline at all (structure, not content). */
export class TimelineInvalidoError extends Error {
  constructor(readonly reason: TimelineInvalidoReason) {
    super(`The reel scenes are invalid: ${reason}`);
    this.name = 'TimelineInvalidoError';
  }
}

/** One or more scenes have no usable video: the slot is missing (`faltante`) or the clip was not probed as a video. */
export class EscenaSinVideoError extends Error {
  constructor(readonly escenas: readonly number[]) {
    super(`${escenas.length} scene(s) have no video (scenes ${escenas.join(', ')})`);
    this.name = 'EscenaSinVideoError';
  }
}

/** In/out marks outside the clip, reversed, or only one of the two. */
export class MarcasFueraDeRangoError extends Error {
  constructor(readonly escenas: readonly number[]) {
    super(`${escenas.length} scene(s) have in/out marks outside their clip (scenes ${escenas.join(', ')})`);
    this.name = 'MarcasFueraDeRangoError';
  }
}

/** A scene lasts longer than the stretch of its clip that it may use. */
export class EscenaMasLargaQueLaFuenteError extends Error {
  constructor(readonly escenas: readonly number[]) {
    super(`${escenas.length} scene(s) are longer than their source stretch (scenes ${escenas.join(', ')})`);
    this.name = 'EscenaMasLargaQueLaFuenteError';
  }
}

/** The reel, in whole frames, is shorter or longer than the allowed range. */
export class DuracionTotalFueraDeRangoError extends Error {
  constructor(
    readonly totalMs: number,
    readonly minMs: number,
    readonly maxMs: number,
  ) {
    super(`The reel lasts ${totalMs} ms; it must last ${minMs} to ${maxMs} ms`);
    this.name = 'DuracionTotalFueraDeRangoError';
  }
}

/** A source is HDR and this FFmpeg cannot tone-map it to SDR (no zscale/tonemap). */
export class HdrNoSoportadoError extends Error {
  constructor(readonly escenas: readonly number[]) {
    super(`${escenas.length} scene(s) are HDR and this FFmpeg cannot tone-map them (scenes ${escenas.join(', ')})`);
    this.name = 'HdrNoSoportadoError';
  }
}

export type RutaInvalidaReason = 'fuente_faltante' | 'overlay_faltante' | 'overlay_sobrante' | 'salida_faltante' | 'ruta_no_absoluta' | 'ruta_con_caracter_de_control' | 'ruta_con_patron';

/** A path given to the argument builder is missing, extra, relative, or has control characters. Paths are never echoed. */
export class RutaInvalidaError extends Error {
  constructor(readonly reason: RutaInvalidaReason) {
    super(`A path for FFmpeg is invalid: ${reason}`);
    this.name = 'RutaInvalidaError';
  }
}

export type SalidaInvalidaRazon =
  | 'salida_no_creada'
  | 'formato_contenedor'
  | 'tamano'
  | 'codec_video'
  | 'perfil'
  | 'pix_fmt'
  | 'fps'
  | 'fotogramas'
  | 'duracion'
  | 'audio'
  | 'color'
  | 'tamano_maximo'
  | 'faststart'
  | 'streams_inesperados'
  | 'etiqueta_no_permitida'
  | 'atomo_no_permitido'
  | 'moov_demasiado_grande';

/**
 * The MP4 FFmpeg wrote is not what was asked for, or carries metadata that must not be published.
 * `detalle` is a tag KEY or a box type, never a value, and never client content. Nothing is stored.
 */
export class SalidaInvalidaError extends Error {
  constructor(
    readonly razon: SalidaInvalidaRazon,
    readonly detalle?: string,
  ) {
    super(`The rendered reel is not valid: ${razon}${detalle === undefined ? '' : ` (${detalle})`}`);
    this.name = 'SalidaInvalidaError';
  }
}

/** A source video could not be read, or has no video stream. Carries the media id only. */
export class FuenteDeVideoIlegibleError extends Error {
  constructor(
    readonly mediaId: string,
    readonly razon: 'no_se_pudo_leer' | 'sin_video',
  ) {
    super(`The source video ${mediaId} cannot be used: ${razon}`);
    this.name = 'FuenteDeVideoIlegibleError';
  }
}

/**
 * A Remotion code path was called while REMOTION_LICENCIA is unset (Step 7c). The license gate: Remotion
 * is disabled and the reel falls back to the 7b PNG overlays; nothing is rendered by Remotion.
 */
export class RemotionLicenciaNoConfiguradaError extends Error {
  constructor() {
    super('Remotion is disabled: REMOTION_LICENCIA is not set (see docs/ADR-06_REMOTION_LICENCIA.md)');
    this.name = 'RemotionLicenciaNoConfiguradaError';
  }
}

/** The animated-text engine or its browser is not available in this process (a deployment fault). */
export class RemotionNoDisponibleError extends Error {
  constructor(readonly razon: 'paquete_ausente' | 'navegador_ausente') {
    super(`The animated text engine is not available: ${razon}`);
    this.name = 'RemotionNoDisponibleError';
  }
}

export type TiemposInvalidosRazon = 'duracion_invalida' | 'duracion_insuficiente' | 'reglas_invalidas';

/** The word timing cannot be computed for this duration or these rules. A reason only: never the text. */
export class TiemposInvalidosError extends Error {
  constructor(readonly razon: TiemposInvalidosRazon) {
    super(`The word timing is invalid: ${razon}`);
    this.name = 'TiemposInvalidosError';
  }
}

export type PlantillaInvalidaRazon = 'plantilla_desconocida' | 'entrada_invalida' | 'palabras_no_coinciden' | 'props_invalidas';

/**
 * The props of a text template cannot be built. `campos` are the NAMES of the failing fields (only for
 * `props_invalidas`), never their values: a value could be client text.
 */
export class PlantillaInvalidaError extends Error {
  constructor(
    readonly razon: PlantillaInvalidaRazon,
    readonly campos: readonly string[] = [],
  ) {
    super(`The template props are invalid: ${razon}${campos.length > 0 ? ` (${campos.join(', ')})` : ''}`);
    this.name = 'PlantillaInvalidaError';
  }
}

export type CapaTextoRazon = 'entrada_invalida' | 'fallo_de_bundle' | 'fallo_de_render' | 'tiempo_agotado' | 'salida_incompleta' | 'solicitud_externa';

/** The text layer of a scene could not be drawn. Ids and a fixed reason only: never the text. */
export class CapaTextoError extends Error {
  constructor(readonly razon: CapaTextoRazon) {
    super(`The animated text layer could not be rendered: ${razon}`);
    this.name = 'CapaTextoError';
  }
}

/** A reel was asked for in a process that has no FFmpeg configured. A deployment fault, not a refusal. */
export class ReelNoConfiguradoError extends Error {
  constructor() {
    super('Reel production is not configured in this process (no FFmpeg runtime)');
    this.name = 'ReelNoConfiguradoError';
  }
}
