// Typed errors of the piece service. Messages are state names and ids at most: never content.

/** The change of state is not allowed by section 15 (or a paused piece would not return to where it was paused). */
export class InvalidTransitionError extends Error {
  constructor(
    readonly desde: string,
    readonly hacia: string,
  ) {
    super(`Invalid piece transition: ${desde} -> ${hacia}`);
    this.name = 'InvalidTransitionError';
  }
}

/** The piece does not exist for this client. */
export class PiezaNotFoundError extends Error {
  constructor() {
    super('Piece not found');
    this.name = 'PiezaNotFoundError';
  }
}

/** Resume was requested for a piece that is not paused. */
export class NotPausedError extends Error {
  constructor(readonly estado: string) {
    super(`The piece is not paused (state: ${estado})`);
    this.name = 'NotPausedError';
  }
}

export class InvalidPiezaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPiezaInputError';
  }
}

/** The piece belongs to a discarded plan: it can never change state again. */
export class PlanDescartadoError extends Error {
  constructor() {
    super('The plan of this piece is discarded');
    this.name = 'PlanDescartadoError';
  }
}
