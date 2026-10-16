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
