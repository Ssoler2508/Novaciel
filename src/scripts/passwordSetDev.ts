import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { assertDevUser, setDevPassword } from './passwordSetDevCore.js';
import { parsePasswordSetDevArgs } from './aprobacionesArgs.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';
import { readPassword } from './passwordInput.js';

const SCRIPT = 'password:set-dev';

/**
 * `npm run password:set-dev -- --email <email>`
 * Development-only. Sets the password of a FICTIONAL user (an @example.test address, for example the seeded
 * client approver) so the developer can log in for a manual check. The password comes from a hidden prompt
 * or stdin, never from an argument or the environment, and is never printed. Setting it revokes the user's
 * sessions. Refuses production and *_test databases.
 */
async function main(): Promise<void> {
  const args = parsePasswordSetDevArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  await assertDevUser(pool, args.email);
  const password = await readPassword();
  const result = await setDevPassword(pool, args.email, password);
  console.log(`Password set for ${result.email} (existing sessions revoked, lockout cleared)`);
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : `${SCRIPT} failed`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
