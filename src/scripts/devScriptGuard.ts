import type { Db } from '../db/types.js';

// The guard of the development-only scripts that write data or spend budget (plan:generate,
// brief:generate). It refuses production and any database whose name ends in
// _test, before and after connecting. Messages name the script and the database, never the URL.

function databaseNameFromUrl(script: string, databaseUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(databaseUrl).pathname;
  } catch {
    throw new Error(`${script} refused: DATABASE_URL is not a valid URL`);
  }
  const raw = pathname.replace(/^\/+/, '');
  if (!raw) throw new Error(`${script} refused: DATABASE_URL has no database name`);
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error(`${script} refused: DATABASE_URL has an invalid database name`);
  }
}

function refuseTestDatabase(script: string, name: string): never {
  throw new Error(`${script} refused: database "${name}" is a test database (name ends in _test)`);
}

/** Runs before connecting. Returns the database name found in the URL. */
export function assertDevScriptAllowed(script: string, params: { nodeEnv: string; databaseUrl: string }): string {
  if (params.nodeEnv === 'production') throw new Error(`${script} refused: NODE_ENV is production`);
  const name = databaseNameFromUrl(script, params.databaseUrl);
  if (name.endsWith('_test')) refuseTestDatabase(script, name);
  return name;
}

/** Second check once connected: the server's own answer must not be a test database either. */
export async function confirmDevScriptDatabase(script: string, db: Pick<Db, 'query'>): Promise<string> {
  const { rows } = await db.query('SELECT current_database() AS name');
  const name = String((rows[0] as { name: unknown } | undefined)?.name ?? '');
  if (!name) throw new Error(`${script} refused: could not read current_database()`);
  if (name.endsWith('_test')) refuseTestDatabase(script, name);
  return name;
}
