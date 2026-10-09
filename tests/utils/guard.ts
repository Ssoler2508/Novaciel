import type { Db } from '../../src/db/types.js';

const TEST_SUFFIX = '_test';

/** Extracts the database name from a connection URL; throws if there is none. */
export function parseDatabaseName(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Test safety guard: the database URL is not a valid URL');
  }
  const raw = parsed.pathname.replace(/^\/+/, '');
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw new Error('Test safety guard: the database name in the URL is not valid percent-encoding');
  }
  if (name === '') {
    // Without a name, pg would fall back to PGDATABASE or the user name.
    throw new Error('Test safety guard: the database URL has no database name');
  }
  return name;
}

/** Pure check on a URL; never connects. Returns the database name when it is safe. */
export function assertTestDatabaseUrl(url: string): string {
  const name = parseDatabaseName(url);
  if (!name.endsWith(TEST_SUFFIX)) {
    throw new Error(
      `Test safety guard: database "${name}" does not end in "${TEST_SUFFIX}". Refusing to run tests.`,
    );
  }
  return name;
}

/** Confirms with the server which database the connection really points to. */
export async function assertTestDatabase(db: Db): Promise<string> {
  const { rows } = await db.query<{ name: string }>('SELECT current_database() AS name');
  const name = rows[0]?.name;
  if (name === undefined || !name.endsWith(TEST_SUFFIX)) {
    throw new Error(
      `Test safety guard: connected database "${name ?? 'unknown'}" does not end in "${TEST_SUFFIX}". Refusing to run tests.`,
    );
  }
  return name;
}
