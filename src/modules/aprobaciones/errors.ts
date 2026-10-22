// Typed errors of the approval services and the publish gate. Messages and fields carry ids, states and
// counts only: never a comment, a caption or a client text.

/** The user may not do this at this level for this client. Also for a NovaCiel user at the client level. */
export class PermisoDenegadoError extends Error {
  constructor(readonly accion: string) {
    super(`Not allowed: ${accion}`);
    this.name = 'PermisoDenegadoError';
  }
}

/** The input of a decision is malformed (field names only). */
export class AprobacionInvalidaError extends Error {
  constructor(readonly campos: readonly string[]) {
    super(`Invalid approval input: ${campos.join(', ')}`);
    this.name = 'AprobacionInvalidaError';
  }
}

/** The piece is not in a state where this level can decide. */
export class PiezaEstadoNoDecidibleError extends Error {
  constructor(
    readonly nivel: string,
    readonly estado: string,
  ) {
    super(`A piece in ${estado} cannot get a ${nivel} decision`);
    this.name = 'PiezaEstadoNoDecidibleError';
  }
}

/** The piece has no current production to decide on. */
export class SinProduccionError extends Error {
  constructor() {
    super('The piece has no current production');
    this.name = 'SinProduccionError';
  }
}

/** The approver was shown another hash than the current one: the piece changed while they looked (409). */
export class HashDesactualizadoError extends Error {
  constructor(readonly produccionId: string) {
    super(`The piece changed since it was shown (production ${produccionId})`);
    this.name = 'HashDesactualizadoError';
  }
}

/** The plan changed since the approver saw it (409). */
export class HuellaDesactualizadaError extends Error {
  constructor(readonly planId: string) {
    super(`The plan changed since it was shown (plan ${planId})`);
    this.name = 'HuellaDesactualizadaError';
  }
}

/** Only a draft plan can be proposed. */
export class PlanNoProponibleError extends Error {
  constructor(readonly estado: string) {
    super(`The plan cannot be proposed from state ${estado}`);
    this.name = 'PlanNoProponibleError';
  }
}

/** Only a proposed plan can be decided on. */
export class PlanNoDecidibleError extends Error {
  constructor(readonly estado: string) {
    super(`The plan cannot be decided on in state ${estado}`);
    this.name = 'PlanNoDecidibleError';
  }
}

// ---- assertPublicable ------------------------------------------------------------------------

/** The piece is not in `aprobada` or `programada`, or its plan is not approved. */
export class PiezaNoPublicableError extends Error {
  constructor(
    readonly estado: string,
    readonly planEstado: string,
  ) {
    super(`The piece cannot be published from state ${estado} (plan ${planEstado})`);
    this.name = 'PiezaNoPublicableError';
  }
}

/** The records do not say "approved" for the current production. */
export class SinAprobacionVigenteError extends Error {
  constructor(readonly estadoAprobacion: string) {
    super(`The current production is not approved (${estadoAprobacion})`);
    this.name = 'SinAprobacionVigenteError';
  }
}

/** A stored file is missing from storage, or its bytes or size differ from what was recorded. */
export class ArchivoAlteradoError extends Error {
  constructor(
    readonly orden: number,
    readonly motivo: 'ausente' | 'sha256' | 'tamano',
  ) {
    super(`File ${orden} of the production does not match what was approved (${motivo})`);
    this.name = 'ArchivoAlteradoError';
  }
}

/** The np1 hash recomputed from the stored data differs from the stored or the approved hash. */
export class HashPiezaNoCoincideError extends Error {
  constructor(
    readonly produccionId: string,
    readonly contra: 'almacenado' | 'aprobado',
  ) {
    super(`The recomputed piece hash differs from the ${contra} one (production ${produccionId})`);
    this.name = 'HashPiezaNoCoincideError';
  }
}
