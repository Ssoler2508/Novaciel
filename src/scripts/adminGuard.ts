import type { Db } from '../db/types.js';

// Guard for create-admin. Unlike the seed guard it does NOT refuse NODE_ENV=production: this is
// also an operations script, and the first production administrator is created with it.
// It only refuses test databases. Messages name the database and never include the URL.

function databaseNameFromUrl(databaseUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(databaseUrl).pathname;
  } catch {
    // Do not echo the URL: it may contain credentials.
    throw new Error('create-admin refused: DATABASE_URL is not a valid URL');
  }
  const raw = pathname.replace(/^\/+/, '');
  if (!raw) throw new Error('create-admin refused: DATABASE_URL has no database name');
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error('create-admin refused: DATABASE_URL has an invalid database name');
  }
}

function refuseTestDatabase(name: string): never {
  throw new Error(`create-admin refused: database "${name}" is a test database (name ends in _test)`);
}

/** Runs before connecting: checks the name in the URL (percent-decoded). */
export function assertAdminDatabaseAllowed(databaseUrl: string): string {
  const name = databaseNameFromUrl(databaseUrl);
  if (name.endsWith('_test')) refuseTestDatabase(name);
  return name;
}

/** Second check once connected: the server's own answer must not be a test database either. */
export async function confirmAdminDatabase(db: Pick<Db, 'query'>): Promise<string> {
  const { rows } = await db.query('SELECT current_database() AS name');
  const name = String((rows[0] as { name: unknown } | undefined)?.name ?? '');
  if (!name) throw new Error('create-admin refused: could not read current_database()');
  if (name.endsWith('_test')) refuseTestDatabase(name);
  return name;
}
