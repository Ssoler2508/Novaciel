import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../lib/logger/index.js';
import { loadConfig } from './index.js';

const secret = 'x'.repeat(32);
const key1 = Buffer.alloc(32, 1).toString('base64');
const key2 = Buffer.alloc(32, 2).toString('base64');

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  LOG_LEVEL: 'info',
  LOCAL_STORAGE_SIGNING_SECRET: secret,
  SECRETS_KEYS: `1:${key1}`,
  SECRETS_ACTIVE_KEY_VERSION: '1',
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
      loadConfig({ ...valid, NODE_ENV: 'production', STORAGE_DRIVER: 's3', LLM_PROVIDER: 'fake', ...s3Vars }),
    ).not.toThrow();
  });
});

describe('secrets config', () => {
  const withSecrets = (SECRETS_KEYS: string, SECRETS_ACTIVE_KEY_VERSION = '1') =>
    loadConfig({ ...valid, SECRETS_KEYS, SECRETS_ACTIVE_KEY_VERSION });

  it('parses several versions and the active one', () => {
    const cfg = withSecrets(`1:${key1},2:${key2}`, '2');
    expect(cfg.secrets.activeVersion).toBe(2);
    expect(cfg.secrets.versions).toEqual([1, 2]);
    expect(cfg.secrets.getKey(1)).toEqual(Buffer.alloc(32, 1));
  });

  it('is required in every environment', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => loadConfig({ ...valid, NODE_ENV, SECRETS_KEYS: undefined })).toThrow(/SECRETS_KEYS/);
      expect(() =>
        loadConfig({ ...valid, NODE_ENV, SECRETS_ACTIVE_KEY_VERSION: undefined }),
      ).toThrow(/SECRETS_ACTIVE_KEY_VERSION/);
    }
  });

  it('rejects a short key without printing it', () => {
    const short = Buffer.alloc(16, 7).toString('base64');
    expect(() => withSecrets(`1:${short}`)).toThrow(/exactly 32 bytes/);
    try {
      withSecrets(`1:${short}`);
    } catch (err) {
      expect((err as Error).message).not.toContain(short);
    }
  });

  it.each(['nocolon', ':abc', `x:${key1}`, `0:${key1}`, `1:${key1},`])(
    'rejects the malformed list %j',
    (list) => {
      expect(() => withSecrets(list)).toThrow(/SECRETS_KEYS/);
    },
  );

  it('rejects a duplicate version', () => {
    expect(() => withSecrets(`1:${key1},1:${key2}`)).toThrow(/more than once/);
  });

  it('rejects an active version that is missing from the list', () => {
    expect(() => withSecrets(`1:${key1}`, '2')).toThrow(/not present in SECRETS_KEYS/);
    expect(() => withSecrets(`1:${key1}`, 'abc')).toThrow(/positive integer/);
  });

  it('validates base64 strictly: invalid characters that Buffer would skip are rejected', () => {
    const bad = `${key1.slice(0, 10)}!!${key1.slice(10)}`;
    // Premise: lenient decoding would have accepted this key as 32 bytes.
    expect(Buffer.from(bad, 'base64').length).toBe(32);
    expect(() => withSecrets(`1:${bad}`)).toThrow(/not valid base64/);
    expect(() => withSecrets(`1:${key1.replace(/=+$/, '')}`)).toThrow(/not valid base64/);
  });

  it('never exposes key bytes through JSON, util.inspect or pino', () => {
    const { secrets } = withSecrets(`1:${key1},2:${key2}`, '2');
    const expected = { activeVersion: 2, versions: [1, 2] };
    expect(JSON.parse(JSON.stringify(secrets))).toEqual(expected);

    const lines: string[] = [];
    const log = createLogger('info', { write: (line: string) => void lines.push(line) });
    log.info({ secrets }, 'config loaded');
    const outputs = [JSON.stringify(secrets), inspect(secrets, { showHidden: true }), lines.join('')];
    for (const out of outputs) {
      expect(out).not.toContain(key1);
      expect(out).not.toContain(key2);
    }
    expect(JSON.parse(lines[0] ?? '{}').secrets).toEqual(expected);
  });
});

describe('password scrypt cost', () => {
  it('defaults to 15', () => {
    expect(loadConfig(valid).PASSWORD_SCRYPT_LOG_N).toBe(15);
  });

  it('rejects values below 15 outside NODE_ENV=test', () => {
    for (const NODE_ENV of ['development', 'production']) {
      const env = { ...valid, NODE_ENV, STORAGE_DRIVER: NODE_ENV === 'production' ? 's3' : 'local', LLM_PROVIDER: 'fake', ...s3Vars };
      expect(() => loadConfig({ ...env, PASSWORD_SCRYPT_LOG_N: '14' })).toThrow(/PASSWORD_SCRYPT_LOG_N/);
      expect(loadConfig({ ...env, PASSWORD_SCRYPT_LOG_N: '15' }).PASSWORD_SCRYPT_LOG_N).toBe(15);
    }
  });

  it('allows lower values when NODE_ENV=test, but not absurd ones', () => {
    expect(loadConfig({ ...valid, PASSWORD_SCRYPT_LOG_N: '10' }).PASSWORD_SCRYPT_LOG_N).toBe(10);
    expect(() => loadConfig({ ...valid, PASSWORD_SCRYPT_LOG_N: '3' })).toThrow(/PASSWORD_SCRYPT_LOG_N/);
    expect(() => loadConfig({ ...valid, PASSWORD_SCRYPT_LOG_N: '25' })).toThrow(/PASSWORD_SCRYPT_LOG_N/);
  });
});

describe('session config', () => {
  it('defaults to 12 hours and 120 idle minutes', () => {
    const cfg = loadConfig(valid);
    expect([cfg.SESSION_TTL_HOURS, cfg.SESSION_IDLE_MINUTES]).toEqual([12, 120]);
  });

  it('accepts overrides and rejects invalid values', () => {
    const cfg = loadConfig({ ...valid, SESSION_TTL_HOURS: '8', SESSION_IDLE_MINUTES: '30' });
    expect([cfg.SESSION_TTL_HOURS, cfg.SESSION_IDLE_MINUTES]).toEqual([8, 30]);
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect(() => loadConfig({ ...valid, SESSION_TTL_HOURS: bad })).toThrow(/SESSION_TTL_HOURS/);
      expect(() => loadConfig({ ...valid, SESSION_IDLE_MINUTES: bad })).toThrow(/SESSION_IDLE_MINUTES/);
    }
  });
});

describe('llm config', () => {
  const production = { ...valid, NODE_ENV: 'production', STORAGE_DRIVER: 's3', ...s3Vars };

  it('defaults to the fake provider and model in development and test', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(loadConfig({ ...valid, NODE_ENV }).llm).toEqual({ provider: 'fake', model: 'fake-model', timeoutMs: 60_000 });
    }
  });

  it('requires LLM_PROVIDER to be set explicitly in production', () => {
    expect(() => loadConfig(production)).toThrow(/LLM_PROVIDER/);
    expect(loadConfig({ ...production, LLM_PROVIDER: 'fake' }).llm.provider).toBe('fake');
  });

  it('requires LLM_MODEL with the claude provider and passes it through', () => {
    expect(() => loadConfig({ ...valid, LLM_PROVIDER: 'claude' })).toThrow(/LLM_MODEL/);
    const llm = loadConfig({ ...valid, LLM_PROVIDER: 'claude', LLM_MODEL: 'some-model', NOVACIEL_ANTHROPIC_API_KEY: 'sk-fake-key' }).llm;
    expect(llm).toMatchObject({ provider: 'claude', model: 'some-model', timeoutMs: 60_000 });
    expect(llm.apiKey?.reveal()).toBe('sk-fake-key');
  });

  it('rejects an unknown provider', () => {
    expect(() => loadConfig({ ...valid, LLM_PROVIDER: 'gpt' })).toThrow(/LLM_PROVIDER/);
  });
});
