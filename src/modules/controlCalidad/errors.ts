// Typed errors of the quality-control service. They carry ids, states and names only, never text of the client.

/** The piece is not in `en_control_calidad` (any more): there is nothing to control. */
export class QcEstadoInvalidoError extends Error {
  constructor(readonly estado: string) {
    super(`Quality control needs the piece in en_control_calidad, not ${estado}`);
    this.name = 'QcEstadoInvalidoError';
  }
}

/** The piece has no production to control. */
export class QcSinProduccionError extends Error {
  constructor() {
    super('The piece has no current production to control');
    this.name = 'QcSinProduccionError';
  }
}

/**
 * A new production replaced the one being checked while the checks ran. Nothing was stored and the piece
 * did not move: the report would have been about a production that is no longer the current one.
 */
export class QcProduccionCambioError extends Error {
  constructor(readonly produccionId: string) {
    super(`The production ${produccionId} changed while it was being controlled; nothing was stored`);
    this.name = 'QcProduccionCambioError';
  }
}

/** A row the production points at is missing (a brief or a brand profile): the data is inconsistent. */
export class QcDatosInconsistentesError extends Error {
  constructor(readonly dato: 'brief' | 'perfil_marca') {
    super(`Quality control could not read the ${dato} of the production`);
    this.name = 'QcDatosInconsistentesError';
  }
}

/** A video is in the production and no ffprobe configuration was given: a setup problem, not a failed piece. */
export class QcSinFfprobeError extends Error {
  constructor() {
    super('Quality control needs the ffprobe configuration to check a video');
    this.name = 'QcSinFfprobeError';
  }
}
