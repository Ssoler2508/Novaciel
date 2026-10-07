import { config } from '../../../config/index.js';
import { S3Storage } from './s3Storage.js';

export type { Storage } from './types.js';
export { FakeStorage } from './fakeStorage.js';
export { S3Storage } from './s3Storage.js';

export function createStorage(): S3Storage {
  return new S3Storage({
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  });
}
