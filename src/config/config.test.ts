import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  LOG_LEVEL: 'info',
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
