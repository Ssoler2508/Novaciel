import type { Storage } from './types.js';

export class FakeStorage implements Storage {
  private readonly objects = new Map<string, { body: Buffer; contentType?: string }>();

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  async get(key: string): Promise<Buffer> {
    const obj = this.objects.get(key);
    if (!obj) throw new Error(`Object not found: ${key}`);
    return Buffer.from(obj.body);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async getSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    if (!this.objects.has(key)) throw new Error(`Object not found: ${key}`);
    return `memory://${encodeURIComponent(key)}?expires=${expiresInSeconds}`;
  }
}
