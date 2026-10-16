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
