import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { runInTransaction } from './transaction.js';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { getTestPool } from '../../tests/utils/testPool.js';

function fakeClient() {
  const calls: string[] = [];
  return { calls, query: vi.fn(async (sql: string) => void calls.push(sql)), release: vi.fn() };
}

function fakePool(client: ReturnType<typeof fakeClient>) {
  const pool = Object.create(pg.Pool.prototype) as pg.Pool;
  (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => client;
  return pool;
}

describe('runInTransaction with a Pool', () => {
  it('wraps the work in BEGIN / COMMIT and releases the client', async () => {
    const client = fakeClient();
    const result = await runInTransaction(fakePool(client), async (tx) => {
      await tx.query('WORK');
      return 42;
    });
    expect(result).toBe(42);
    expect(client.calls).toEqual(['BEGIN', 'WORK', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back on error, rethrows and still releases', async () => {
    const client = fakeClient();
    await expect(
      runInTransaction(fakePool(client), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(client.calls).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('runInTransaction with a client', () => {
  it('wraps the work in SAVEPOINT / RELEASE SAVEPOINT', async () => {
    const client = fakeClient();
    await runInTransaction(client as never, async (tx) => void (await tx.query('WORK')));
    expect(client.calls).toHaveLength(3);
    expect(client.calls[0]).toMatch(/^SAVEPOINT (sp_\d+)$/);
    const name = client.calls[0]!.split(' ')[1];
    expect(client.calls).toEqual([`SAVEPOINT ${name}`, 'WORK', `RELEASE SAVEPOINT ${name}`]);
    expect(client.release).not.toHaveBeenCalled();
  });

  it('rolls back to the savepoint on error and rethrows', async () => {
    const client = fakeClient();
    await expect(
      runInTransaction(client as never, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const name = client.calls[0]!.split(' ')[1];
    expect(client.calls).toEqual([`SAVEPOINT ${name}`, `ROLLBACK TO SAVEPOINT ${name}`]);
  });

  it('undoes only the failed work inside a larger transaction', async () => {
    await withTestTransaction(async (db) => {
      await db.query('INSERT INTO healthcheck DEFAULT VALUES');
      await expect(
        runInTransaction(db, async (tx) => {
          await tx.query('INSERT INTO healthcheck DEFAULT VALUES');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const { rows } = await db.query('SELECT count(*) AS n FROM healthcheck');
      const before = Number(rows[0].n);
      await runInTransaction(db, async (tx) => void (await tx.query('INSERT INTO healthcheck DEFAULT VALUES')));
      expect(Number((await db.query('SELECT count(*) AS n FROM healthcheck')).rows[0].n)).toBe(before + 1);
    });
  });

  it('fails loudly on a real client that is not in a transaction', async () => {
    const client = await getTestPool().connect();
    try {
      await expect(runInTransaction(client, async () => 1)).rejects.toThrow(/SAVEPOINT|transaction/i);
    } finally {
      client.release();
    }
  });
});
