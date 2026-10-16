import type { Db } from '../db/types.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';

// Guard for plan:generate, a development-only script that writes plans and spends budget: the
// shared development-script guard under this script's name.

/** Runs before connecting. Returns the database name found in the URL. */
export function assertPlanGenerateAllowed(params: { nodeEnv: string; databaseUrl: string }): string {
  return assertDevScriptAllowed('plan:generate', params);
}

/** Second check once connected: the server's own answer must not be a test database either. */
export function confirmPlanGenerateDatabase(db: Pick<Db, 'query'>): Promise<string> {
  return confirmDevScriptDatabase('plan:generate', db);
}
