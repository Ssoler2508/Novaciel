import { PutObjectCommand } from '@aws-sdk/client-s3';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S3Storage } from './s3Storage.js';

// A fake client replaces the AWS one, so no test here touches the network.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'novaciel-s3-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeClient() {
  const sent: PutObjectCommand[] = [];
  return {
    sent,
    client: {
      send: async (command: PutObjectCommand) => {
        sent.push(command);
        return {};
      },
    } as never,
  };
}

describe('S3Storage.putFile', () => {
  it('sends one PutObject with a stream body, the exact content length and the content type', async () => {
    const file = path.join(dir, 'video.mp4');
    await writeFile(file, Buffer.alloc(123_456, 7));
    const fake = fakeClient();
    const storage = new S3Storage({ bucket: 'bucket-x', accessKeyId: 'a', secretAccessKey: 'b', client: fake.client });
    await storage.putFile('c/media/v.mp4', file, 'video/mp4');
    expect(fake.sent).toHaveLength(1);
    const input = fake.sent[0]!.input;
    expect(input).toMatchObject({ Bucket: 'bucket-x', Key: 'c/media/v.mp4', ContentLength: 123_456, ContentType: 'video/mp4' });
    // A stream, never a Buffer: the file is not loaded into memory.
    expect(input.Body).toBeInstanceOf(Readable);
    expect(Buffer.isBuffer(input.Body)).toBe(false);
    (input.Body as Readable).destroy();
  });

  it('fails when the source file is missing, without sending anything', async () => {
    const fake = fakeClient();
    const storage = new S3Storage({ bucket: 'b', accessKeyId: 'a', secretAccessKey: 'b', client: fake.client });
    await expect(storage.putFile('k', path.join(dir, 'missing.bin'))).rejects.toThrow();
    expect(fake.sent).toHaveLength(0);
  });
});

describe('S3Storage.getFile', () => {
  const storageWith = (send: (command: unknown) => Promise<unknown>) =>
    new S3Storage({ bucket: 'bucket-x', accessKeyId: 'a', secretAccessKey: 'b', client: { send } as never });

  it('streams the object body into the file', async () => {
    const content = Buffer.from(Array.from({ length: 200_000 }, (_v, i) => (i * 13) % 256));
    const sent: { input: unknown }[] = [];
    const storage = storageWith(async (command) => {
      sent.push(command as { input: unknown });
      return { Body: Readable.from([content.subarray(0, 100_000), content.subarray(100_000)]) };
    });
    const dest = path.join(dir, 'out.bin');
    await storage.getFile('c/media/v.mp4', dest);
    expect(sent[0]!.input).toMatchObject({ Bucket: 'bucket-x', Key: 'c/media/v.mp4' });
    expect((await readFile(dest)).equals(content)).toBe(true);
  });

  it('fails on a missing body or a broken stream and leaves no partial file', async () => {
    const dest = path.join(dir, 'partial.bin');
    await expect(storageWith(async () => ({})).getFile('k', dest)).rejects.toThrow(/Empty body/);
    const broken = new Readable({
      read() {
        this.push(Buffer.alloc(1000, 1));
        this.destroy(new Error('connection reset'));
      },
    });
    await expect(storageWith(async () => ({ Body: broken })).getFile('k', dest)).rejects.toThrow();
    await expect(stat(dest)).rejects.toThrow();
  });
});
