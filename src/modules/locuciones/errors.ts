// Typed errors of the pure voice-over code (Step 7d, checkpoint B). Messages and fields name reasons,
// scene numbers, counts and milliseconds only: NEVER the spoken text or any other client content.

export type LocucionTextoReason =
  | 'token_sin_reemplazar'
  | 'demasiado_largo'
  | 'pide_imagen_ia'
  | 'cifra_libre'
  | 'hecho_texto_cambiado'
  | 'hecho_no_vigente'
  | 'regla_prohibida_palabra'
  | 'regla_prohibida_promesa'
  | 'regla_prohibida_tema';

/** The text of a scene cannot be spoken: it breaks rule 2, a banned rule or a limit. */
export class LocucionTextoInvalidoError extends Error {
  constructor(
    /** The first failing reason in a fixed order. */
    readonly reason: LocucionTextoReason,
    /** Every failing reason, in the same fixed order. */
    readonly motivos: readonly LocucionTextoReason[] = [reason],
  ) {
    super(`The voice-over text cannot be spoken: ${motivos.join(', ')}`);
    this.name = 'LocucionTextoInvalidoError';
  }
}

export type AlineacionReason =
  | 'longitudes_distintas'
  | 'valor_invalido'
  | 'tiempos_no_crecientes'
  | 'no_coincide_con_el_texto'
  | 'palabra_sin_tiempos'
  | 'fuera_de_la_escena';

/** The provider's character alignment cannot be turned into word times for the text. */
export class AlineacionInvalidaError extends Error {
  constructor(readonly reason: AlineacionReason) {
    super(`The voice alignment is invalid: ${reason}`);
    this.name = 'AlineacionInvalidaError';
  }
}

export interface EscenaExcedida {
  escena: number;
  /** How many ms the voice (with its margins) is longer than the rendered scene. */
  excesoMs: number;
}

/** A voice does not fit its scene. Lists ALL the scenes that do not fit. The brief is regenerated shorter; no word is cut. */
export class LocucionMasLargaQueEscenaError extends Error {
  constructor(readonly escenas: readonly EscenaExcedida[]) {
    super(`The voice is longer than its scene in scene(s): ${escenas.map((e) => `${e.escena} (+${e.excesoMs} ms)`).join(', ')}`);
    this.name = 'LocucionMasLargaQueEscenaError';
  }
}

/** The reel is shorter or longer than the house range (15 to 30 s). */
export class DuracionReelFueraDeRangoError extends Error {
  constructor(
    readonly totalMs: number,
    readonly minMs: number,
    readonly maxMs: number,
  ) {
    super(`The reel lasts ${totalMs} ms; it must last between ${minMs} and ${maxMs} ms`);
    this.name = 'DuracionReelFueraDeRangoError';
  }
}

export type LocucionEntradaReason =
  | 'duracion_de_escena_invalida'
  | 'duracion_de_voz_invalida'
  | 'escenas_vacias'
  | 'texto_mal_formado'
  | 'campo_vacio'
  | 'ajuste_fuera_de_rango'
  | 'idioma_invalido';

/** An input of the voice code is not valid (a number, a string or a setting). */
export class LocucionEntradaInvalidaError extends Error {
  constructor(readonly reason: LocucionEntradaReason) {
    super(`Invalid voice-over input: ${reason}`);
    this.name = 'LocucionEntradaInvalidaError';
  }
}
