import type { PoolClient } from 'pg';
import { assertTestDatabase } from './guard.js';
import { getTestPool } from './testPool.js';

/** Runs `fn` inside a transaction that is always rolled back. Default for database tests. */
export async function withTestTransaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await getTestPool().connect();
  try {
    await assertTestDatabase(client);
    await client.query('BEGIN');
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}
