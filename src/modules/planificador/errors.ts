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
