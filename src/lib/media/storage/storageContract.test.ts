import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeStorage } from './fakeStorage.js';
import { LocalFileStorage } from './localFileStorage.js';
import type { Storage } from './types.js';

const badKeys: [string, string][] = [
  ['parent traversal', '../x'],
  ['nested traversal', 'a/../../x'],
  ['backslash traversal', '..\\x'],
  ['drive letter', 'C:\\x'],
  ['absolute path', '/etc/x'],
  ['colon', 'a:b'],
  ['reserved name', 'con'],
  ['reserved name with extension', 'nul.txt'],
  ['reserved name in a folder', 'a/COM1.log/x'],
  ['trailing dot segment', 'a./b'],
  ['dot segment', 'a/./b'],
  ['empty key', ''],
  ['empty segment', 'a//b'],
  ['null byte', 'a\0b'],
  ['too long segment', 'a'.repeat(256)],
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'novaciel-storage-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const factories: [string, () => Storage][] = [
  ['FakeStorage', () => new FakeStorage()],
  [
    'LocalFileStorage',
    () =>
      new LocalFileStorage({
        baseDir: path.join(dir, 'store'),
        signingSecret: 's'.repeat(32),
        publicBaseUrl: 'http://localhost:3000',
      }),
  ],
];

describe.each(factories)('Storage contract: %s', (_name, make) => {
  it('round-trips put / get / delete, including nested keys', async () => {
    const s = make();
    for (const key of ['top.txt', 'a/b/c/deep.bin']) {
      await s.put(key, Buffer.from('hello'), 'text/plain');
      expect((await s.get(key)).toString()).toBe('hello');
      await s.delete(key);
      await expect(s.get(key)).rejects.toThrow(/not found/);
    }
  });

  it('overwrites an existing key', async () => {
    const s = make();
    await s.put('k', Buffer.from('one'));
    await s.put('k', Buffer.from('two'));
    expect((await s.get('k')).toString()).toBe('two');
  });

  it('throws on get of a missing key and ignores delete of a missing key', async () => {
    const s = make();
    await expect(s.get('missing/key')).rejects.toThrow('Object not found: missing/key');
    await expect(s.delete('missing/key')).resolves.toBeUndefined();
  });

  it('throws on getSignedUrl of a missing key', async () => {
    await expect(make().getSignedUrl('missing')).rejects.toThrow(/not found/);
  });

  it('returns a signed url for an existing key', async () => {
    const s = make();
    await s.put('k.txt', Buffer.from('x'));
    expect(await s.getSignedUrl('k.txt', 60)).toContain('k.txt');
  });

  it.each(badKeys)('rejects a bad key in every operation: %s', async (_label, key) => {
    const s = make();
    await expect(s.put(key, Buffer.from('x'))).rejects.toThrow(/Invalid storage key/);
    await expect(s.get(key)).rejects.toThrow(/Invalid storage key/);
    await expect(s.delete(key)).rejects.toThrow(/Invalid storage key/);
    await expect(s.getSignedUrl(key)).rejects.toThrow(/Invalid storage key/);
  });
});

describe.each(factories)('Storage contract, putFile: %s', (_name, make) => {
  async function sourceFile(content: Buffer): Promise<string> {
    const file = path.join(dir, 'source.bin');
    await writeFile(file, content);
    return file;
  }

  it('stores the file content byte for byte, with nested keys', async () => {
    const s = make();
    const content = Buffer.from(Array.from({ length: 70_000 }, (_v, i) => (i * 7) % 256));
    const file = await sourceFile(content);
    await s.putFile('a/b/photo.jpg', file, 'image/jpeg');
    expect((await s.get('a/b/photo.jpg')).equals(content)).toBe(true);
  });

  it('overwrites an existing key and keeps the source file', async () => {
    const s = make();
    await s.put('k.bin', Buffer.from('old'));
    const file = await sourceFile(Buffer.from('new'));
    await s.putFile('k.bin', file);
    expect((await s.get('k.bin')).toString()).toBe('new');
    expect((await readdir(dir)).includes('source.bin')).toBe(true);
  });

  it('rejects a missing source file and stores nothing', async () => {
    const s = make();
    await expect(s.putFile('k.bin', path.join(dir, 'does-not-exist.bin'))).rejects.toThrow();
    await expect(s.get('k.bin')).rejects.toThrow(/not found/);
  });

  it.each(badKeys)('rejects a bad key: %s', async (_label, key) => {
    const s = make();
    const file = await sourceFile(Buffer.from('x'));
    await expect(s.putFile(key, file)).rejects.toThrow(/Invalid storage key/);
  });
});

describe('LocalFileStorage putFile on disk', () => {
  it('leaves no temp file after a success or a failure, and streams without loading the file', async () => {
    const base = path.join(dir, 'store');
    const s = new LocalFileStorage({ baseDir: base, signingSecret: 's'.repeat(32), publicBaseUrl: 'http://localhost:3000' });
    const file = path.join(dir, 'in.bin');
    await writeFile(file, Buffer.alloc(300_000, 1));
    await s.putFile('x/ok.bin', file);
    await expect(s.putFile('x/bad.bin', path.join(dir, 'missing.bin'))).rejects.toThrow();
    expect(await readdir(path.join(base, 'x'))).toEqual(['ok.bin']);
  });
});

describe('LocalFileStorage on disk', () => {
  it('creates the base folder and leaves no temp files after put', async () => {
    const base = path.join(dir, 'new', 'base');
    const s = new LocalFileStorage({
      baseDir: base,
      signingSecret: 's'.repeat(32),
      publicBaseUrl: 'http://localhost:3000',
    });
    await s.put('a/b.txt', Buffer.from('x'));
    expect(await readdir(base)).toEqual(['a']);
    expect(await readdir(path.join(base, 'a'))).toEqual(['b.txt']);
  });

  it('never writes outside the base folder', async () => {
    const base = path.join(dir, 'store');
    const s = new LocalFileStorage({
      baseDir: base,
      signingSecret: 's'.repeat(32),
      publicBaseUrl: 'http://localhost:3000',
    });
    await expect(s.put('../escape.txt', Buffer.from('x'))).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['store']);
  });
});
