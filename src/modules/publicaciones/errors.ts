// Typed errors of the pure publishing rules (Step 10, checkpoint B). Messages and fields name reasons and
// counts only: NEVER an id, a caption or any other client content.

export type ClaveIdempotenciaReason = 'pieza_id_invalido' | 'produccion_id_invalido' | 'hash_pieza_invalido';

/** The inputs of the idempotency key are malformed. */
export class ClaveIdempotenciaEntradaError extends Error {
  constructor(readonly reason: ClaveIdempotenciaReason) {
    super(`The idempotency key input is invalid: ${reason}`);
    this.name = 'ClaveIdempotenciaEntradaError';
  }
}

/** No allowed slot was found inside the search window (every slot vetoed). */
export class SinHorarioPermitidoError extends Error {
  constructor(readonly diasBuscados: number) {
    super(`No allowed publishing slot within ${diasBuscados} days`);
    this.name = 'SinHorarioPermitidoError';
  }
}

export type MetricasEntradaReason = 'no_es_objeto';

/** The raw metrics of a provider are not an object at all (a value that is merely invalid becomes NULL instead). */
export class MetricasEntradaError extends Error {
  constructor(readonly reason: MetricasEntradaReason) {
    super(`The raw metrics cannot be read: ${reason}`);
    this.name = 'MetricasEntradaError';
  }
}

// ---- Checkpoint C: scheduling and publishing services. Reasons and states only, never ids or client text. ----

/** The time asked for breaks a scheduling rule (it is in the past or in a vetoed window). */
export class ProgramacionInvalidaError extends Error {
  constructor(readonly motivos: readonly string[]) {
    super(`The scheduled time is not allowed: ${motivos.join(', ')}`);
    this.name = 'ProgramacionInvalidaError';
  }
}

/** The piece is not in a state this operation works from. */
export class PiezaEstadoProgramacionError extends Error {
  constructor(
    readonly estado: string,
    readonly operacion: 'programar' | 'reprogramar' | 'publicar',
  ) {
    super(`Cannot ${operacion} a piece in state ${estado}`);
    this.name = 'PiezaEstadoProgramacionError';
  }
}

/** A schedule change was asked while an attempt is still open (no result yet) or already published. */
export class PublicacionAbiertaError extends Error {
  constructor() {
    super('The piece has a publication attempt without a final result');
    this.name = 'PublicacionAbiertaError';
  }
}

/** `publicarPieza` was called before the scheduled time. */
export class PublicacionPrematuraError extends Error {
  constructor() {
    super('The scheduled time has not come yet');
    this.name = 'PublicacionPrematuraError';
  }
}

/** The network has no active, unexpired connection for this client. The piece goes to fallo_publicacion. */
export class ConexionNoDisponibleError extends Error {
  constructor(readonly motivo: 'ausente' | 'vencida') {
    super(`No usable connection for the network (${motivo})`);
    this.name = 'ConexionNoDisponibleError';
  }
}

/** The piece needs the AI-content label and the provider cannot set it on this network. */
export class EtiquetaIaNoSoportadaError extends Error {
  constructor() {
    super('The provider cannot set the AI-content label for this network');
    this.name = 'EtiquetaIaNoSoportadaError';
  }
}

/** The files read back before sending differ from the recorded ones: nothing was sent. */
export class ArchivoAlteradoAlEnviarError extends Error {
  constructor(readonly orden: number) {
    super(`File ${orden} changed before sending; nothing was sent`);
    this.name = 'ArchivoAlteradoAlEnviarError';
  }
}

/** The retries are used up with no known outcome; a person has to look. Nothing is resent. */
export class PublicacionAgotadaError extends Error {
  constructor() {
    super('The publication attempts are used up');
    this.name = 'PublicacionAgotadaError';
  }
}

export type PoliticaReintentosReason ='intentos_invalidos' | 'espera_invalida' | 'azar_invalido';

/** A programming error in the arguments of the retry policy. */
export class PoliticaReintentosEntradaError extends Error {
  constructor(readonly reason: PoliticaReintentosReason) {
    super(`The retry policy input is invalid: ${reason}`);
    this.name = 'PoliticaReintentosEntradaError';
  }
}
