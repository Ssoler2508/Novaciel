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

export type PoliticaReintentosReason = 'intentos_invalidos' | 'espera_invalida' | 'azar_invalido';

/** A programming error in the arguments of the retry policy. */
export class PoliticaReintentosEntradaError extends Error {
  constructor(readonly reason: PoliticaReintentosReason) {
    super(`The retry policy input is invalid: ${reason}`);
    this.name = 'PoliticaReintentosEntradaError';
  }
}
