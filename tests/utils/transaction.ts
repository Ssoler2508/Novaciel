import type { PoolClient } from 'pg';
import { assertTestDatabase } from './guard.js';
import { getTestPool } from './testPool.js';

export interface TestTransactionOptions {
  /**
   * For tests of the generic state machine only: turns on, for the whole transaction, the test-only switch
   * that lets a piece enter `aprobada`/`programada` without approvals (the Step 9 database guard
   * historial_estados_pieza_aprobacion). Honoured only by a *_test database. Never for approval tests.
   */
  sinGuardaDeAprobacion?: boolean;
}

/** Runs `fn` inside a transaction that is always rolled back. Default for database tests. */
export async function withTestTransaction<T>(fn: (db: PoolClient) => Promise<T>, options: TestTransactionOptions = {}): Promise<T> {
  const client = await getTestPool().connect();
  try {
    await assertTestDatabase(client);
    await client.query('BEGIN');
    if (options.sinGuardaDeAprobacion) await client.query(`SELECT set_config('novaciel.omitir_guarda_aprobacion', 'si', true)`);
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}
