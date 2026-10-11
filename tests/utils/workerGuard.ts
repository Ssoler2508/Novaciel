import { afterAll, beforeAll } from 'vitest';
import { closePool, pool } from '../../src/db/pool.js';
import { assertTestDatabase } from './guard.js';
import { closeTestPool } from './testPool.js';

// Runs in every test worker, before any test file: the global pool (built from
// src/config's DATABASE_URL) must point to a "_test" database.
beforeAll(async () => {
  await assertTestDatabase(pool);
});

afterAll(async () => {
  await closeTestPool();
  await closePool();
});
