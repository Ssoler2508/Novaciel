import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { runInTransaction } from '../db/transaction.js';
import { assertSeedAllowed, confirmSeedDatabase } from './seedGuard.js';
import { seedDevelopment } from './seedDevelopment.js';

/**
 * `npm run seed`: fictional data for local development only. Never prints DATABASE_URL or any part
 * of it other than the database name.
 */
async function main(): Promise<void> {
  // Guard 1, before connecting: environment and the name in the URL.
  const urlName = assertSeedAllowed({ nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  // Guard 2, once connected: the server's own current_database().
  const database = await confirmSeedDatabase(pool);
  console.log(`Seeding database "${database}" (url name "${urlName}")`);

  const result = await runInTransaction(pool, (tx) => seedDevelopment(tx));

  console.log(`Created: ${result.created.length}`);
  for (const item of result.created) console.log(`  + ${item}`);
  console.log(`Already present: ${result.existing.length}`);
  for (const item of result.existing) console.log(`  = ${item}`);
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : 'Seed failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
