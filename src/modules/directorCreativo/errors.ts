// Typed errors of the pure creative-director code. Messages name fields, ids and reasons only:
// never client content.

/** The profile or piece data the director needs is missing or malformed. `field` is a path like "voz". */
export class BriefContextError extends Error {
  constructor(readonly field: string) {
    super(`The creative director cannot use the data: invalid or missing "${field}"`);
    this.name = 'BriefContextError';
  }
}

export type FactTokenErrorKind = 'unknown' | 'expired' | 'leftover';

/**
 * A fact token cannot be turned into its stored value: the id is not among the facts given
 * (`unknown`), the fact is not valid at the instant (`expired`), or a token survived rendering
 * (`leftover`, a bug).
 */
export class FactTokenError extends Error {
  constructor(
    readonly kind: FactTokenErrorKind,
    readonly hechoId: string | null,
  ) {
    super(
      {
        unknown: `Fact token names an unknown fact (${hechoId})`,
        expired: `Fact token names a fact that is not valid at that instant (${hechoId})`,
        leftover: 'A fact token survived rendering',
      }[kind],
    );
    this.name = 'FactTokenError';
  }
}

/** The piece is not in a state a brief can be made from (plan_aprobado, or guion_listo to regenerate). */
export class PiezaEstadoInvalidoError extends Error {
  constructor(readonly estado: string) {
    super(`A brief cannot be made for a piece in state ${estado}`);
    this.name = 'PiezaEstadoInvalidoError';
  }
}

/** The piece already has a current brief and the caller did not ask to regenerate it. */
export class BriefExistenteError extends Error {
  constructor(readonly version: number) {
    super(`The piece already has a current brief (version ${version})`);
    this.name = 'BriefExistenteError';
  }
}

/** The piece or its briefs changed while the model was running: nothing is stored. */
export class BriefObsoletoError extends Error {
  constructor() {
    super('The piece changed while the brief was being written; nothing was stored');
    this.name = 'BriefObsoletoError';
  }
}

/** A fact used by the brief is not valid any more (now, or when the piece goes out): nothing is stored. */
export class BriefHechoVencidoError extends Error {
  constructor(readonly hechoIds: readonly string[]) {
    super(`${hechoIds.length} fact(s) used by the brief are no longer valid`);
    this.name = 'BriefHechoVencidoError';
  }
}

/** A media item chosen by the brief stopped being usable (rights, authorization, deleted): nothing is stored. */
export class BriefMediaNoUsableError extends Error {
  constructor(readonly mediaIds: readonly string[]) {
    super(`${mediaIds.length} media item(s) chosen by the brief are no longer usable`);
    this.name = 'BriefMediaNoUsableError';
  }
}
