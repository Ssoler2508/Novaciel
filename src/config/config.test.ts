import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const secret = 'x'.repeat(32);

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  LOG_LEVEL: 'info',
  LOCAL_STORAGE_SIGNING_SECRET: secret,
};

const s3Vars = {
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const cfg = loadConfig(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('test');
  });

  it.each(Object.keys(valid))('fails when %s is missing', (name) => {
    const env: Record<string, string | undefined> = { ...valid };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(name);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'devSoler' })).toThrow(/NODE_ENV/);
  });
});

describe('storage config', () => {
  it('defaults to the local driver in development and test', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const cfg = loadConfig({ ...valid, NODE_ENV });
      expect(cfg.storage).toMatchObject({ driver: 'local', dir: './.data/storage' });
    }
  });

  it('builds the public base url from PORT and strips trailing slashes', () => {
    expect(loadConfig(valid).storage).toMatchObject({ publicBaseUrl: 'http://localhost:3000' });
    const cfg = loadConfig({ ...valid, PUBLIC_BASE_URL: 'https://dev.example.com/' });
    expect(cfg.storage).toMatchObject({ publicBaseUrl: 'https://dev.example.com' });
  });

  it('"local" passes without any S3 variable', () => {
    expect(() => loadConfig({ ...valid, STORAGE_DRIVER: 'local' })).not.toThrow();
  });

  it('"local" requires the signing secret, at least 32 chars', () => {
    const { LOCAL_STORAGE_SIGNING_SECRET: _omit, ...rest } = valid;
    expect(() => loadConfig({ ...rest, STORAGE_DRIVER: 'local' })).toThrow(
      /LOCAL_STORAGE_SIGNING_SECRET/,
    );
    expect(() => loadConfig({ ...valid, LOCAL_STORAGE_SIGNING_SECRET: 'short' })).toThrow(
      /LOCAL_STORAGE_SIGNING_SECRET/,
    );
  });

  it('"s3" without S3 variables fails and names each missing one', () => {
    expect(() => loadConfig({ ...valid, STORAGE_DRIVER: 's3' })).toThrow(
      /S3_BUCKET.*S3_ACCESS_KEY.*S3_SECRET_KEY/,
    );
  });

  it('"s3" works without an endpoint and does not need the signing secret', () => {
    const { LOCAL_STORAGE_SIGNING_SECRET: _omit, ...rest } = valid;
    const cfg = loadConfig({ ...rest, STORAGE_DRIVER: 's3', ...s3Vars });
    expect(cfg.storage).toMatchObject({ driver: 's3', bucket: 'bucket', endpoint: undefined });
  });

  it('treats empty values (as in .env.example) as not set', () => {
    expect(() => loadConfig({ ...valid, STORAGE_DRIVER: 's3', S3_BUCKET: '' })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...valid, S3_ENDPOINT: '', PUBLIC_BASE_URL: '' })).not.toThrow();
  });

  it('"local" in production fails', () => {
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', STORAGE_DRIVER: 'local' }),
    ).toThrow(/not allowed in production/);
  });

  it('production requires STORAGE_DRIVER to be set explicitly', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/STORAGE_DRIVER/);
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', STORAGE_DRIVER: 's3', ...s3Vars }),
    ).not.toThrow();
  });
});
