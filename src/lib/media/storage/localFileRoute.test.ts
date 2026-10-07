import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLocalFileRoute } from './localFileRoute.js';
import { LocalFileStorage } from './localFileStorage.js';

let dir: string;
let storage: LocalFileStorage;
let app: FastifyInstance;

/** Turns an absolute signed url into a path + query that app.inject accepts. */
function toPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'novaciel-route-'));
  storage = new LocalFileStorage({
    baseDir: dir,
    signingSecret: 's'.repeat(32),
    publicBaseUrl: 'http://localhost:3000/',
  });
  app = Fastify();
  registerLocalFileRoute(app, storage);
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('GET /files/*', () => {
  it('serves the file for a valid signed url, with the right content type', async () => {
    await storage.put('clients/1/photo.png', Buffer.from('png-bytes'));
    const url = await storage.getSignedUrl('clients/1/photo.png');
    expect(url.startsWith('http://localhost:3000/files/clients/1/photo.png?')).toBe(true);

    const res = await app.inject({ method: 'GET', url: toPath(url) });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString()).toBe('png-bytes');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('falls back to octet-stream for unknown extensions', async () => {
    await storage.put('blob.xyz', Buffer.from('x'));
    const res = await app.inject({ method: 'GET', url: toPath(await storage.getSignedUrl('blob.xyz')) });
    expect(res.headers['content-type']).toBe('application/octet-stream');
  });

  it('rejects an expired link', async () => {
    await storage.put('a.txt', Buffer.from('x'));
    const url = await storage.getSignedUrl('a.txt', 60);
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    const res = await app.inject({ method: 'GET', url: toPath(url) });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a tampered signature', async () => {
    await storage.put('a.txt', Buffer.from('x'));
    const p = toPath(await storage.getSignedUrl('a.txt'));
    const flipped = p.slice(0, -1) + (p.endsWith('0') ? '1' : '0');
    expect((await app.inject({ method: 'GET', url: flipped })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: p.replace(/sig=.*/, 'sig=abc') })).statusCode).toBe(403);
  });

  it('rejects a tampered expiry or a different key with the same signature', async () => {
    await storage.put('a.txt', Buffer.from('x'));
    await storage.put('b.txt', Buffer.from('y'));
    const p = toPath(await storage.getSignedUrl('a.txt'));
    const expires = Number(/expires=(\d+)/.exec(p)![1]);
    expect(
      (await app.inject({ method: 'GET', url: p.replace(`expires=${expires}`, `expires=${expires + 9999}`) }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: p.replace('/a.txt', '/b.txt') })).statusCode).toBe(403);
  });

  it('rejects an invalid key before anything else', async () => {
    for (const bad of ['/files/con?expires=9999999999&sig=aa', '/files/a%2F..%2Fx?expires=9999999999&sig=aa', '/files/..%5Cx?expires=9999999999&sig=aa']) {
      expect((await app.inject({ method: 'GET', url: bad })).statusCode).toBe(400);
    }
  });

  it('rejects missing or malformed query parameters', async () => {
    expect((await app.inject({ method: 'GET', url: '/files/a.txt' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/files/a.txt?expires=x&sig=aa' })).statusCode).toBe(400);
  });

  it('returns 404 for a validly signed url whose file was deleted', async () => {
    await storage.put('gone.txt', Buffer.from('x'));
    const p = toPath(await storage.getSignedUrl('gone.txt'));
    await storage.delete('gone.txt');
    expect((await app.inject({ method: 'GET', url: p })).statusCode).toBe(404);
  });
});
