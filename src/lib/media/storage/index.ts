import type { StorageConfig } from '../../../config/index.js';
import { LocalFileStorage } from './localFileStorage.js';
import { S3Storage } from './s3Storage.js';

export type { Storage } from './types.js';
export { FakeStorage } from './fakeStorage.js';
export { LocalFileStorage } from './localFileStorage.js';
export { registerLocalFileRoute } from './localFileRoute.js';
export { S3Storage } from './s3Storage.js';

export function createStorage(cfg: StorageConfig): LocalFileStorage | S3Storage {
  if (cfg.driver === 'local') {
    return new LocalFileStorage({
      baseDir: cfg.dir,
      signingSecret: cfg.signingSecret,
      publicBaseUrl: cfg.publicBaseUrl,
    });
  }
  return new S3Storage({
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
}
