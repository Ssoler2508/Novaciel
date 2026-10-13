import { describe, expect, it } from 'vitest';
import { assertAdminDatabaseAllowed, confirmAdminDatabase } from './adminGuard.js';

// Pure tests with fake URLs: no database, and create-admin itself is never called.
const url = (name: string) => `postgresql://fakeuser:fakepassword@localhost:5432/${name}`;

describe('assertAdminDatabaseAllowed', () => {
  it('accepts development and production-style names', () => {
    expect(assertAdminDatabaseAllowed(url('fake_dev'))).toBe('fake_dev');
    expect(assertAdminDatabaseAllowed(url('novaciel_prod'))).toBe('novaciel_prod');
  });

  it('refuses a name ending in _test, also percent-encoded, and names it', () => {
    expect(() => assertAdminDatabaseAllowed(url('fake_test'))).toThrow(/"fake_test"/);
    expect(() => assertAdminDatabaseAllowed(url('fake%5Ftest'))).toThrow(/"fake_test"/);
  });

  it('refuses invalid URLs without echoing them', () => {
    for (const bad of ['not a url', 'postgresql://fakeuser:fakepassword@localhost:5432', 'postgresql://u:p@h:5432/']) {
      let message = '';
      try {
        assertAdminDatabaseAllowed(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/refused/);
      expect(message).not.toContain('fakepassword');
    }
  });

  it('never puts credentials in the message', () => {
    expect(() => assertAdminDatabaseAllowed(url('fake_test'))).not.toThrow(/fakepassword|fakeuser/);
  });
});

describe('confirmAdminDatabase', () => {
  const fake = (name: unknown) => ({ query: async () => ({ rows: [{ name }] }) }) as never;

  it('accepts a normal database and refuses a _test one reported by the server', async () => {
    expect(await confirmAdminDatabase(fake('novaciel_db'))).toBe('novaciel_db');
    await expect(confirmAdminDatabase(fake('novaciel_db_test'))).rejects.toThrow(/test database/);
    await expect(confirmAdminDatabase(fake(''))).rejects.toThrow(/current_database/);
  });
});
