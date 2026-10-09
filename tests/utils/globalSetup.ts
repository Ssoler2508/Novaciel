import path from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { assertTestDatabase, assertTestDatabaseUrl } from './guard.js';

/** Runs once before all tests: guard first, then migrate the test database up. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  assertTestDatabaseUrl(url);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await assertTestDatabase(client);
    await runner({
      dbClient: client,
      dir: path.join(process.cwd(), 'src', 'db', 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    });
  } finally {
    await client.end();
  }
}
