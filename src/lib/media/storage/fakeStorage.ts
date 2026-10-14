import { readFile } from 'node:fs/promises';
import { validateKey } from './keys.js';
import type { Storage } from './types.js';

export class FakeStorage implements Storage {
  private readonly objects = new Map<string, { body: Buffer; contentType?: string }>();

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    validateKey(key);
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  async putFile(key: string, filePath: string, contentType?: string): Promise<void> {
    validateKey(key);
    // A test double: reading the whole file is fine here. The real implementations stream.
    this.objects.set(key, { body: await readFile(filePath), contentType });
  }

  /** Test helper: true when an object exists under `key`. */
  has(key: string): boolean {
    return this.objects.has(key);
  }

  /** Test helper: every stored key. */
  keys(): string[] {
    return [...this.objects.keys()];
  }

  async get(key: string): Promise<Buffer> {
    validateKey(key);
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`Object not found: ${key}`);
    return Buffer.from(obj.body);
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    this.objects.delete(key);
  }

  async getSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    validateKey(key);
    if (!this.objects.has(key)) throw new Error(`Object not found: ${key}`);
    return `memory://${encodeURIComponent(key)}?expires=${expiresInSeconds}`;
  }
}
