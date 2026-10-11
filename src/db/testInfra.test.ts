import { describe, expect, it } from 'vitest';
import { assertTestDatabase, assertTestDatabaseUrl } from '../../tests/utils/guard.js';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { cleanupDomainTables } from '../../tests/utils/cleanup.js';
import { getTestPool } from '../../tests/utils/testPool.js';

describe('safety guard (URL)', () => {
  it('rejects a database name without _test and names it', () => {
    expect(() => assertTestDatabaseUrl('postgresql://u:p@localhost:5432/fake_db')).toThrow(/"fake_db"/);
  });

  it('rejects a URL with no database name', () => {
    expect(() => assertTestDatabaseUrl('postgresql://u:p@localhost:5432')).toThrow(/no database name/);
    expect(() => assertTestDatabaseUrl('postgresql://u:p@localhost:5432/')).toThrow(/no database name/);
  });

  it('decodes a percent-encoded name before checking', () => {
    expect(() => assertTestDatabaseUrl('postgresql://u:p@localhost:5432/fake%5Fdb')).toThrow(/"fake_db"/);
    expect(assertTestDatabaseUrl('postgresql://u:p@localhost:5432/fake%5Ftest')).toBe('fake_test');
    expect(() => assertTestDatabaseUrl('postgresql://u:p@localhost:5432/fake_test%2Fx')).toThrow();
  });

  it('accepts a name ending in _test', () => {
    expect(assertTestDatabaseUrl('postgresql://u:p@localhost:5432/fake_test?sslmode=disable')).toBe('fake_test');
  });
});

describe('safety guard (connection)', () => {
  it('confirms the real connection is a _test database', async () => {
    await expect(assertTestDatabase(getTestPool())).resolves.toMatch(/_test$/);
  });

  it('rejects a connection whose current_database does not end in _test', async () => {
    const fake = { query: async () => ({ rows: [{ name: 'novaciel_db' }] }) };
    await expect(assertTestDatabase(fake as never)).rejects.toThrow(/"novaciel_db"/);
  });
});

describe('withTestTransaction', () => {
  it('rolls back rows inserted by the test body', async () => {
    const count = async () =>
      Number((await getTestPool().query('SELECT count(*) AS n FROM healthcheck')).rows[0].n);
    const before = await count();
    const inside = await withTestTransaction(async (db) => {
      await db.query('INSERT INTO healthcheck DEFAULT VALUES');
      return Number((await db.query('SELECT count(*) AS n FROM healthcheck')).rows[0].n);
    });
    expect(inside).toBe(before + 1);
    expect(await count()).toBe(before);
  });
});

describe('cleanupDomainTables', () => {
  it('runs through the guard without touching anything while the list is empty', async () => {
    await expect(cleanupDomainTables(getTestPool())).resolves.toBeUndefined();
  });
});
