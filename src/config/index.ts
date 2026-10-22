import 'dotenv/config';
import { inspect } from 'node:util';
import { z } from 'zod';
import { SecretValue } from './secretValue.js';

const KEY_BYTES = 32;
const MIN_SCRYPT_LOG_N = 15;
// Standard alphabet with mandatory padding. Buffer.from(x, 'base64') silently skips invalid
// characters, so the format is checked before decoding.
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Encryption keyring. Key bytes are private and never serialized: JSON.stringify,
 * pino and util.inspect only show the versions.
 */
export class SecretsConfig {
  readonly #keys: ReadonlyMap<number, Buffer>;
  readonly activeVersion: number;
  // Public data only: toJSON must not touch private state, because pino's redaction calls it
  // on a copy of the object.
  readonly versions: readonly number[];

  constructor(keys: ReadonlyMap<number, Buffer>, activeVersion: number) {
    this.#keys = keys;
    this.activeVersion = activeVersion;
    this.versions = [...keys.keys()].sort((a, b) => a - b);
  }

  getKey(version: number): Buffer | undefined {
    return this.#keys.get(version);
  }

  toJSON() {
    return { activeVersion: this.activeVersion, versions: this.versions };
  }

  [inspect.custom]() {
    return this.toJSON();
  }
}

type SecretsParse = { issues: [string, string][]; keys: Map<number, Buffer>; active?: number };

/** Messages name the variable and the entry position, never the key material. */
function parseSecrets(rawKeys: string | undefined, rawActive: string | undefined): SecretsParse {
  const out: SecretsParse = { issues: [], keys: new Map() };
  if (rawKeys === undefined || rawActive === undefined) return out; // zod reports the missing variable
  rawKeys.split(',').forEach((entry, i) => {
    const n = i + 1;
    const sep = entry.trim().indexOf(':');
    const version = entry.trim().slice(0, sep);
    const key = entry.trim().slice(sep + 1);
    if (sep < 1 || !/^[1-9]\d*$/.test(version)) {
      out.issues.push(['SECRETS_KEYS', `entry ${n} must have the form version:base64key`]);
    } else if (out.keys.has(Number(version))) {
      out.issues.push(['SECRETS_KEYS', `version ${version} is listed more than once`]);
    } else if (!STRICT_BASE64.test(key)) {
      out.issues.push(['SECRETS_KEYS', `key of version ${version} is not valid base64`]);
    } else {
      const bytes = Buffer.from(key, 'base64');
      if (bytes.length !== KEY_BYTES) {
        out.issues.push(['SECRETS_KEYS', `key of version ${version} must decode to exactly ${KEY_BYTES} bytes`]);
      } else {
        out.keys.set(Number(version), bytes);
      }
    }
  });
  if (!/^[1-9]\d*$/.test(rawActive)) {
    out.issues.push(['SECRETS_ACTIVE_KEY_VERSION', 'must be a positive integer']);
  } else if (out.issues.length === 0 && !out.keys.has(Number(rawActive))) {
    out.issues.push(['SECRETS_ACTIVE_KEY_VERSION', `version ${rawActive} is not present in SECRETS_KEYS`]);
  } else {
    out.active = Number(rawActive);
  }
  return out;
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535),
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    STORAGE_DRIVER: z.enum(['local', 's3']).optional(),
    LOCAL_STORAGE_DIR: z.string().min(1).default('./.data/storage'),
    LOCAL_STORAGE_SIGNING_SECRET: z.string().min(32).optional(),
    PUBLIC_BASE_URL: z.url().optional(),
    S3_ENDPOINT: z.url().optional(),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY: z.string().min(1).optional(),
    S3_SECRET_KEY: z.string().min(1).optional(),
    LLM_PROVIDER: z.enum(['fake', 'claude']).optional(),
    LLM_MODEL: z.string().min(1).optional(),
    // Media library: ffprobe location and limits.
    FFPROBE_PATH: z.string().min(1).default('ffprobe'),
    FFPROBE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
    // FFmpeg (reel production, Step 7b): the executable and the time limit of one render.
    FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
    FFMPEG_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(600_000),
    // Remotion (Step 7c): the operator's declaration of which Remotion license applies. NO default: unset
    // means Remotion is disabled (reels keep the 7b PNG overlays). See docs/ADR-06_REMOTION_LICENCIA.md.
    REMOTION_LICENCIA: z.enum(['gratuita', 'empresa']).optional(),
    // Absolute path of the Chrome Headless Shell that Remotion renders with. Optional: by default the one that
    // `npm run remotion:browser` downloaded into node_modules/.remotion is used.
    REMOTION_NAVEGADOR: z.string().min(1).optional(),
    // Default 200 MiB; bounds 1 MiB to 2 GiB.
    MEDIA_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(2_147_483_648).default(209_715_200),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
    // Our own key. Never ANTHROPIC_API_KEY: Claude Code reads that one for its own login.
    NOVACIEL_ANTHROPIC_API_KEY: z.string().min(1).optional(),
    SECRETS_KEYS: z.string().min(1),
    SECRETS_ACTIVE_KEY_VERSION: z.string().min(1),
    // scrypt cost is 2^N; 15 is the production minimum, tests may go lower.
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(60 * 24 * 30).default(120),
    PASSWORD_SCRYPT_LOG_N: z.coerce.number().int().min(4).max(18).default(MIN_SCRYPT_LOG_N),
  })
  .superRefine((env, ctx) => {
    const require = (name: keyof typeof env, message: string) => {
      if (env[name] === undefined) ctx.addIssue({ code: 'custom', path: [name], message });
    };
    if (env.LLM_PROVIDER === undefined && env.NODE_ENV === 'production') {
      require('LLM_PROVIDER', 'must be set explicitly in production');
    }
    if (resolveLlmProvider(env) === 'claude') {
      require('LLM_MODEL', 'required when LLM_PROVIDER is "claude"');
      require('NOVACIEL_ANTHROPIC_API_KEY', 'required when LLM_PROVIDER is "claude"');
    }
    const driver = resolveDriver(env);
    if (driver === undefined) {
      require('STORAGE_DRIVER', 'must be set explicitly in production');
    } else if (driver === 'local') {
      if (env.NODE_ENV === 'production') {
        ctx.addIssue({
          code: 'custom',
          path: ['STORAGE_DRIVER'],
          message: '"local" is not allowed in production',
        });
      }
      require('LOCAL_STORAGE_SIGNING_SECRET', 'required when STORAGE_DRIVER is "local"');
    } else {
      require('S3_BUCKET', 'required when STORAGE_DRIVER is "s3"');
      require('S3_ACCESS_KEY', 'required when STORAGE_DRIVER is "s3"');
      require('S3_SECRET_KEY', 'required when STORAGE_DRIVER is "s3"');
    }
    if (env.NODE_ENV !== 'test' && env.PASSWORD_SCRYPT_LOG_N < MIN_SCRYPT_LOG_N) {
      ctx.addIssue({
        code: 'custom',
        path: ['PASSWORD_SCRYPT_LOG_N'],
        message: `must be at least ${MIN_SCRYPT_LOG_N} outside NODE_ENV=test`,
      });
    }
    const parsed = parseSecrets(env.SECRETS_KEYS, env.SECRETS_ACTIVE_KEY_VERSION);
    for (const [path, message] of parsed.issues) ctx.addIssue({ code: 'custom', path: [path], message });
  });

type Env = z.infer<typeof schema>;

export type StorageConfig =
  | { driver: 'local'; dir: string; signingSecret: string; publicBaseUrl: string }
  | {
      driver: 's3';
      endpoint?: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

export interface LlmConfig {
  provider: 'fake' | 'claude';
  model: string;
  timeoutMs: number;
  /** Only with provider "claude". Printing it shows a placeholder; use reveal() at the point of use. */
  apiKey?: SecretValue;
}

// The raw key is not part of the plain config object; it lives in config.llm.apiKey.
export interface MediaConfig {
  ffprobePath: string;
  ffprobeTimeoutMs: number;
  ffmpegPath: string;
  /** Time limit of one FFmpeg render, in ms. */
  ffmpegTimeoutMs: number;
  /** Largest accepted upload, in bytes. */
  maxBytes: number;
}

export interface RemotionConfig {
  /** The declared Remotion license, or undefined: Remotion is disabled. */
  licencia: 'gratuita' | 'empresa' | undefined;
  /** Absolute path of the browser executable, or undefined: the downloaded one. */
  navegador: string | undefined;
}

export type Config = Omit<Env, 'NOVACIEL_ANTHROPIC_API_KEY'> & {
  storage: StorageConfig;
  secrets: SecretsConfig;
  llm: LlmConfig;
  media: MediaConfig;
  remotion: RemotionConfig;
};

/** "fake" by default outside production; in production there is no default. */
function resolveLlmProvider(env: Pick<Env, 'NODE_ENV' | 'LLM_PROVIDER'>): 'fake' | 'claude' | undefined {
  if (env.LLM_PROVIDER) return env.LLM_PROVIDER;
  return env.NODE_ENV === 'production' ? undefined : 'fake';
}

// The only model name that may live in code: the fake provider's, which has a fake price in the seed.
const FAKE_MODEL = 'fake-model';

function buildLlmConfig(env: Env): LlmConfig {
  const provider = resolveLlmProvider(env);
  if (!provider) throw new Error('Invalid LLM configuration');
  const timeoutMs = env.LLM_TIMEOUT_MS;
  if (provider === 'fake') return { provider, model: env.LLM_MODEL ?? FAKE_MODEL, timeoutMs };
  if (!env.LLM_MODEL || !env.NOVACIEL_ANTHROPIC_API_KEY) throw new Error('Invalid LLM configuration');
  return { provider, model: env.LLM_MODEL, timeoutMs, apiKey: new SecretValue(env.NOVACIEL_ANTHROPIC_API_KEY) };
}

/** "local" by default outside production; in production there is no default. */
function resolveDriver(env: Pick<Env, 'NODE_ENV' | 'STORAGE_DRIVER'>): 'local' | 's3' | undefined {
  if (env.STORAGE_DRIVER) return env.STORAGE_DRIVER;
  return env.NODE_ENV === 'production' ? undefined : 'local';
}

function buildStorageConfig(env: Env): StorageConfig {
  // superRefine already guarantees these are present; the checks narrow the types.
  if (resolveDriver(env) === 's3') {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
      throw new Error('Invalid storage configuration');
    }
    return {
      driver: 's3',
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    };
  }
  if (!env.LOCAL_STORAGE_SIGNING_SECRET) throw new Error('Invalid storage configuration');
  return {
    driver: 'local',
    dir: env.LOCAL_STORAGE_DIR,
    signingSecret: env.LOCAL_STORAGE_SIGNING_SECRET,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, ''),
  };
}

/** Validates an env-like object; throws listing every missing or invalid variable. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  // An empty value (e.g. `S3_BUCKET=` copied from .env.example) counts as not set.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const { keys, active } = parseSecrets(result.data.SECRETS_KEYS, result.data.SECRETS_ACTIVE_KEY_VERSION);
  if (active === undefined) throw new Error('Invalid secrets configuration');
  const { NOVACIEL_ANTHROPIC_API_KEY: _apiKey, ...publicEnv } = result.data;
  return {
    ...publicEnv,
    storage: buildStorageConfig(result.data),
    secrets: new SecretsConfig(keys, active),
    llm: buildLlmConfig(result.data),
    media: {
      ffprobePath: result.data.FFPROBE_PATH,
      ffprobeTimeoutMs: result.data.FFPROBE_TIMEOUT_MS,
      ffmpegPath: result.data.FFMPEG_PATH,
      ffmpegTimeoutMs: result.data.FFMPEG_TIMEOUT_MS,
      maxBytes: result.data.MEDIA_MAX_BYTES,
    },
    remotion: { licencia: result.data.REMOTION_LICENCIA, navegador: result.data.REMOTION_NAVEGADOR },
  };
}

function loadOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

export const config: Config = loadOrExit();
