import { describe, expect, it } from 'vitest';
import { assertSeedAllowed, confirmSeedDatabase } from './seedGuard.js';

// Pure tests with fake URLs: no database, and the seed itself is never called.
const url = (name: string) => `postgresql://fakeuser:fakepassword@localhost:5432/${name}`;

describe('assertSeedAllowed', () => {
  it('accepts a development database', () => {
    expect(assertSeedAllowed({ nodeEnv: 'development', databaseUrl: url('fake_dev') })).toBe('fake_dev');
  });

  it('rejects NODE_ENV=production', () => {
    expect(() => assertSeedAllowed({ nodeEnv: 'production', databaseUrl: url('fake_dev') })).toThrow(/production/);
  });

  it('rejects a database name ending in _test and names it', () => {
    expect(() => assertSeedAllowed({ nodeEnv: 'development', databaseUrl: url('fake_test') })).toThrow(/"fake_test"/);
  });

  it('decodes a percent-encoded name before checking', () => {
    expect(() => assertSeedAllowed({ nodeEnv: 'development', databaseUrl: url('fake%5Ftest') })).toThrow(/"fake_test"/);
  });

  it('rejects a URL with no database name', () => {
    expect(() => assertSeedAllowed({ nodeEnv: 'development', databaseUrl: 'postgresql://u:p@localhost:5432' })).toThrow(
      /no database name/,
    );
    expect(() => assertSeedAllowed({ nodeEnv: 'development', databaseUrl: 'postgresql://u:p@localhost:5432/' })).toThrow(
      /no database name/,
    );
  });

  it('rejects an unparseable URL without echoing it', () => {
    let message = '';
    try {
      assertSeedAllowed({ nodeEnv: 'development', databaseUrl: 'not a url, secret-token' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not a valid URL/);
    expect(message).not.toContain('secret-token');
  });

  it('never puts credentials or the URL in an error message', () => {
    for (const nodeEnv of ['production', 'development']) {
      for (const name of ['fake_test', 'fake_dev']) {
        try {
          assertSeedAllowed({ nodeEnv, databaseUrl: url(name) });
        } catch (err) {
          const message = (err as Error).message;
          expect(message).not.toContain('fakeuser');
          expect(message).not.toContain('fakepassword');
          expect(message).not.toContain('localhost');
        }
      }
    }
  });
});

describe('confirmSeedDatabase', () => {
  const fake = (name: string) => ({ query: async () => ({ rows: [{ name }] }) }) as never;

  it('rejects a connection whose current_database ends in _test and names it', async () => {
    await expect(confirmSeedDatabase(fake('novaciel_test'))).rejects.toThrow(/"novaciel_test"/);
  });

  it('accepts a development database', async () => {
    await expect(confirmSeedDatabase(fake('fake_dev'))).resolves.toBe('fake_dev');
  });
});
