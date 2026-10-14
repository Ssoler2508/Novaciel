import type { Db } from '../db/types.js';

// Guard for media:upload, a development-only script that writes to the media library. It refuses
// production and any database whose name ends in _test, before and after connecting. Messages name
// the database and never include the URL.

function databaseNameFromUrl(databaseUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(databaseUrl).pathname;
  } catch {
    throw new Error('media:upload refused: DATABASE_URL is not a valid URL');
  }
  const raw = pathname.replace(/^\/+/, '');
  if (!raw) throw new Error('media:upload refused: DATABASE_URL has no database name');
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error('media:upload refused: DATABASE_URL has an invalid database name');
  }
}

function refuseTestDatabase(name: string): never {
  throw new Error(`media:upload refused: database "${name}" is a test database (name ends in _test)`);
}

/** Runs before connecting. Returns the database name found in the URL. */
export function assertMediaUploadAllowed(params: { nodeEnv: string; databaseUrl: string }): string {
  if (params.nodeEnv === 'production') throw new Error('media:upload refused: NODE_ENV is production');
  const name = databaseNameFromUrl(params.databaseUrl);
  if (name.endsWith('_test')) refuseTestDatabase(name);
  return name;
}

/** Second check once connected: the server's own answer must not be a test database either. */
export async function confirmMediaUploadDatabase(db: Pick<Db, 'query'>): Promise<string> {
  const { rows } = await db.query('SELECT current_database() AS name');
  const name = String((rows[0] as { name: unknown } | undefined)?.name ?? '');
  if (!name) throw new Error('media:upload refused: could not read current_database()');
  if (name.endsWith('_test')) refuseTestDatabase(name);
  return name;
}
