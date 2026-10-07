import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, LocalFileStorage, S3Storage } from './index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'novaciel-factory-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createStorage', () => {
  it('returns LocalFileStorage for the local driver', () => {
    const storage = createStorage({
      driver: 'local',
      dir: path.join(dir, 'files'),
      signingSecret: 's'.repeat(32),
      publicBaseUrl: 'http://localhost:3000',
    });
    expect(storage).toBeInstanceOf(LocalFileStorage);
  });

  it('returns S3Storage for the s3 driver, with or without an endpoint', () => {
    const base = { driver: 's3', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } as const;
    expect(createStorage(base)).toBeInstanceOf(S3Storage);
    expect(createStorage({ ...base, endpoint: 'https://example.r2.cloudflarestorage.com' })).toBeInstanceOf(
      S3Storage,
    );
  });
});
