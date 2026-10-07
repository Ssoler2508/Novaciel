import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, type ReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateKey } from './keys.js';
import type { Storage } from './types.js';

export interface LocalFileStorageOptions {
  baseDir: string;
  signingSecret: string;
  publicBaseUrl: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Development storage on local disk. Interchangeable with FakeStorage. */
export class LocalFileStorage implements Storage {
  private readonly baseDir: string;
  private readonly signingSecret: string;
  private readonly publicBaseUrl: string;

  constructor(opts: LocalFileStorageOptions) {
    this.baseDir = path.resolve(opts.baseDir);
    this.signingSecret = opts.signingSecret;
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/+$/, '');
    mkdirSync(this.baseDir, { recursive: true });
  }

  async put(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const file = this.resolvePath(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `${path.basename(file)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, body);
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolvePath(key));
    } catch (err) {
      if (isNotFound(err)) throw new Error(`Object not found: ${key}`);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolvePath(key));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async getSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    if (!(await this.exists(key))) throw new Error(`Object not found: ${key}`);
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    return `${this.publicBaseUrl}/files/${key}?expires=${expires}&sig=${this.sign(key, expires)}`;
  }

  /** True when the key is valid and a regular file exists for it. */
  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.resolvePath(key))).isFile();
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** Signature check used by the download route: constant-time, rejects expired links. */
  verify(key: string, expires: number, signature: string): boolean {
    if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.sign(key, expires), 'hex');
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  openReadStream(key: string): ReadStream {
    return createReadStream(this.resolvePath(key));
  }

  contentTypeFor(key: string): string {
    return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
  }

  private sign(key: string, expires: number): string {
    return createHmac('sha256', this.signingSecret).update(`${key}\n${expires}`).digest('hex');
  }

  private resolvePath(key: string): string {
    const segments = validateKey(key);
    const resolved = path.resolve(this.baseDir, ...segments);
    const relative = path.relative(this.baseDir, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    }
    return resolved;
  }
}
