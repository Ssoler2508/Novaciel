import type { Db } from '../db/types.js';

/** Database name from a connection URL, percent-decoded. Never includes credentials. */
function databaseNameFromUrl(databaseUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(databaseUrl).pathname;
  } catch {
    // Do not echo the URL: it may contain credentials.
    throw new Error('Seed refused: DATABASE_URL is not a valid URL');
  }
  const raw = pathname.replace(/^\/+/, '');
  if (!raw) throw new Error('Seed refused: DATABASE_URL has no database name');
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error('Seed refused: DATABASE_URL has an invalid database name');
  }
}

function refuseTestDatabase(name: string): never {
  throw new Error(`Seed refused: database "${name}" is a test database (name ends in _test)`);
}

/**
 * Runs before connecting. The seed is for local development only: it refuses production and any
 * database whose name ends in _test. Messages name the database and never include the URL.
 */
export function assertSeedAllowed(params: { nodeEnv: string; databaseUrl: string }): string {
  if (params.nodeEnv === 'production') {
    throw new Error('Seed refused: NODE_ENV is production');
  }
  const name = databaseNameFromUrl(params.databaseUrl);
  if (name.endsWith('_test')) refuseTestDatabase(name);
  return name;
}

/** Second check once connected: the server's own answer must not be a test database either. */
export async function confirmSeedDatabase(db: Pick<Db, 'query'>): Promise<string> {
  const { rows } = await db.query('SELECT current_database() AS name');
  const name = String((rows[0] as { name: unknown } | undefined)?.name ?? '');
  if (!name) throw new Error('Seed refused: could not read current_database()');
  if (name.endsWith('_test')) refuseTestDatabase(name);
  return name;
}
