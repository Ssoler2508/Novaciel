import type { Db } from '../db/types.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';

// Guards for llm:smoke, a development-only script that makes a real, paid call: the shared
// development-script guard under this script's name, plus the provider and key checks. Messages name
// the database and never include the URL or any key.

/** Runs before connecting: environment, database name, provider and key. Returns the URL's database name. */
export function assertLlmSmokeAllowed(params: {
  nodeEnv: string;
  databaseUrl: string;
  llmProvider: string;
  hasApiKey: boolean;
}): string {
  const name = assertDevScriptAllowed('llm:smoke', { nodeEnv: params.nodeEnv, databaseUrl: params.databaseUrl });
  if (params.llmProvider !== 'claude') {
    throw new Error('llm:smoke needs LLM_PROVIDER=claude (and LLM_MODEL); it is a manual check of the real provider');
  }
  if (!params.hasApiKey) throw new Error('llm:smoke needs NOVACIEL_ANTHROPIC_API_KEY to be set in .env');
  return name;
}

/** Second check once connected: the server's own answer must not be a test database either. */
export function confirmLlmSmokeDatabase(db: Pick<Db, 'query'>): Promise<string> {
  return confirmDevScriptDatabase('llm:smoke', db);
}
