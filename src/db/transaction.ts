import pg from 'pg';
import type { Db } from './types.js';

let savepointCounter = 0;

/**
 * Runs `fn` atomically.
 * - Pool: takes a client and wraps `fn` in BEGIN / COMMIT, ROLLBACK on error, always releases.
 * - Client: wraps `fn` in a SAVEPOINT, so the work stays atomic inside the caller's transaction.
 *   A client that is not in a transaction fails loudly (PostgreSQL rejects SAVEPOINT outside a
 *   transaction block) instead of committing half the work.
 * Detection is `instanceof Pool`: a PoolClient also has connect(), so that is not a valid test.
 */
export async function runInTransaction<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  if (db instanceof pg.Pool) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  }

  const name = `sp_${++savepointCounter}`;
  await db.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn(db);
    await db.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw error;
  }
}
