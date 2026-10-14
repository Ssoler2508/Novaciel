import type { Db } from '../db/types.js';

// Guards for llm:smoke, a development-only script that makes a real, paid call. It refuses
// production and any database whose name ends in _test, before and after connecting. Messages name
// the database and never include the URL or any key.

function databaseNameFromUrl(databaseUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(databaseUrl).pathname;
  } catch {
    throw new Error('llm:smoke refused: DATABASE_URL is not a valid URL');
  }
  const raw = pathname.replace(/^\/+/, '');
  if (!raw) throw new Error('llm:smoke refused: DATABASE_URL has no database name');
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error('llm:smoke refused: DATABASE_URL has an invalid database name');
  }
}

function refuseTestDatabase(name: string): never {
  throw new Error(`llm:smoke refused: database "${name}" is a test database (name ends in _test)`);
}

/** Runs before connecting: environment, database name, provider and key. Returns the URL's database name. */
export function assertLlmSmokeAllowed(params: {
  nodeEnv: string;
  databaseUrl: string;
  llmProvider: string;
  hasApiKey: boolean;
}): string {
  if (params.nodeEnv === 'production') throw new Error('llm:smoke refused: NODE_ENV is production');
  const name = databaseNameFromUrl(params.databaseUrl);
  if (name.endsWith('_test')) refuseTestDatabase(name);
  if (params.llmProvider !== 'claude') {
    throw new Error('llm:smoke needs LLM_PROVIDER=claude (and LLM_MODEL); it is a manual check of the real provider');
  }
  if (!params.hasApiKey) throw new Error('llm:smoke needs NOVACIEL_ANTHROPIC_API_KEY to be set in .env');
  return name;
}

/** Second check once connected: the server's own answer must not be a test database either. */
export async function confirmLlmSmokeDatabase(db: Pick<Db, 'query'>): Promise<string> {
  const { rows } = await db.query('SELECT current_database() AS name');
  const name = String((rows[0] as { name: unknown } | undefined)?.name ?? '');
  if (!name) throw new Error('llm:smoke refused: could not read current_database()');
  if (name.endsWith('_test')) refuseTestDatabase(name);
  return name;
}
