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

export type RutaInvalidaReason = 'fuente_faltante' | 'overlay_faltante' | 'overlay_sobrante' | 'salida_faltante' | 'ruta_no_absoluta' | 'ruta_con_caracter_de_control';

/** A path given to the argument builder is missing, extra, relative, or has control characters. Paths are never echoed. */
export class RutaInvalidaError extends Error {
  constructor(readonly reason: RutaInvalidaReason) {
    super(`A path for FFmpeg is invalid: ${reason}`);
    this.name = 'RutaInvalidaError';
  }
}
