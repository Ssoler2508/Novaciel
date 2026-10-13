import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { assertAdminDatabaseAllowed, confirmAdminDatabase } from './adminGuard.js';
import { parseCreateAdminArgs } from './createAdminArgs.js';
import { createOrUpdateAdmin } from './createAdminCore.js';
import { askVisible, readPassword } from './passwordInput.js';

/**
 * `npm run create-admin -- --email <email> [--nombre <name>]`: creates or updates a user and gives
 * it administrador_novaciel. The password comes from a hidden prompt or stdin, never from an
 * argument or the environment, and is never printed. Refuses *_test databases.
 */
async function main(): Promise<void> {
  const args = parseCreateAdminArgs(process.argv.slice(2));
  const urlName = assertAdminDatabaseAllowed(config.DATABASE_URL);
  const email = args.email ?? (await askVisible('Email: '));
  if (!email) throw new Error('An email is required');
  const password = await readPassword();

  const database = await confirmAdminDatabase(pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  const result = await createOrUpdateAdmin(pool, { email, nombre: args.nombre, password });
  console.log(`${result.created ? 'Created' : 'Updated'} user ${email}`);
  if (result.reactivated) console.log('  + reactivated');
  console.log(result.roleAssigned ? '  + role administrador_novaciel assigned' : '  = already had role administrador_novaciel');
  console.log('  + password set (existing sessions revoked, lockout cleared)');
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : 'create-admin failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
