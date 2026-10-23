import type { Db } from '../db/types.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';

// Guard for media:upload, a development-only script that writes to the media library: the shared
// development-script guard under this script's name.

/** Runs before connecting. Returns the database name found in the URL. */
export function assertMediaUploadAllowed(params: { nodeEnv: string; databaseUrl: string }): string {
  return assertDevScriptAllowed('media:upload', params);
}

/** Second check once connected: the server's own answer must not be a test database either. */
export function confirmMediaUploadDatabase(db: Pick<Db, 'query'>): Promise<string> {
  return confirmDevScriptDatabase('media:upload', db);
}
