// Typed errors of the pure planner code. Messages name fields and reasons only: never client content.

/** The profile data the planner needs is missing or malformed. `field` is a path like "pilares.temas". */
export class PlannerContextError extends Error {
  constructor(readonly field: string) {
    super(`The planner cannot use the profile: invalid or missing "${field}"`);
    this.name = 'PlannerContextError';
  }
}

export type InvalidLocalTimeReason = 'zone' | 'date' | 'time' | 'nonexistent';

/** A zone, date or time that cannot be used, or a local time that does not exist (spring forward gap). */
export class InvalidLocalTimeError extends Error {
  constructor(readonly reason: InvalidLocalTimeReason) {
    super(
      {
        zone: 'Unknown time zone',
        date: 'Invalid local date (expected a real YYYY-MM-DD)',
        time: 'Invalid local time (expected HH:mm, 24 hours)',
        nonexistent: 'That local time does not exist in the zone (it falls in a daylight-saving gap)',
      }[reason],
    );
    this.name = 'InvalidLocalTimeError';
  }
}

/**
 * The client's profile is not complete enough to plan. Lists the incomplete blocks and the NAMES
 * of the missing fields (from completeness), never their values.
 */
export class NoPuedePlanificarError extends Error {
  constructor(readonly bloques: readonly { bloque: string; faltan: readonly string[] }[]) {
    super(`The client cannot be planned yet. Incomplete blocks: ${bloques.map((b) => b.bloque).join(', ') || 'no profile'}`);
    this.name = 'NoPuedePlanificarError';
  }
}

/** The week already has an active plan (and it cannot be replaced, or the caller did not ask to). */
export class PlanExistenteError extends Error {
  constructor(
    readonly planId: string,
    readonly estado: string,
    /** True when the plan is a draft, so `reemplazar: true` would have replaced it. */
    readonly reemplazable: boolean,
  ) {
    super(`The week already has a ${estado} plan`);
    this.name = 'PlanExistenteError';
  }
}

/** A fact the plan cites is no longer valid when the plan is stored (it expired or was edited). */
export class HechoVencidoError extends Error {
  constructor(readonly hechoIds: readonly string[]) {
    super(`${hechoIds.length} cited fact(s) are no longer valid`);
    this.name = 'HechoVencidoError';
  }
}
