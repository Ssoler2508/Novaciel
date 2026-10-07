import 'dotenv/config';
import { z } from 'zod';

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
  })
  .superRefine((env, ctx) => {
    const require = (name: keyof typeof env, message: string) => {
      if (env[name] === undefined) ctx.addIssue({ code: 'custom', path: [name], message });
    };
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

export type Config = Env & { storage: StorageConfig };

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
  return { ...result.data, storage: buildStorageConfig(result.data) };
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
