import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { assignRole, createCliente, createUsuario } from '../../../tests/utils/factories/index.js';
import { config } from '../../config/index.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { registerAuth } from './authRoutes.js';
import { SESSION_COOKIE } from './cookie.js';

// Each test passes the single client of withTestTransaction as Db. app.inject() runs requests
// one at a time on it and runInTransaction falls back to savepoints, so everything rolls back and
// no cleanup helper is needed (that is only required when requests use separate connections).

const PASSWORD = 'correct horse battery';
const ORIGIN = 'http://localhost:3999';
const JSON_HEADERS = { 'content-type': 'application/json' };

async function withApp(
  fn: (ctx: { app: Awaited<ReturnType<typeof build>>['app']; db: Db; logs: string[] }) => Promise<void>,
  options: { secureCookie?: boolean } = {},
) {
  await withTestTransaction(async (db) => {
    const { app, logs } = await build(db, options);
    try {
      await fn({ app, db, logs });
    } finally {
      await app.close();
    }
  });
}

async function build(db: Db, options: { secureCookie?: boolean }) {
  const logs: string[] = [];
  const logger = createLogger('debug', { write: (line: string) => void logs.push(line) });
  const app = Fastify({ loggerInstance: logger });
  await registerAuth(app, { db, allowedOrigin: ORIGIN, ...options });
  return { app, logs };
}

type TestApp = Awaited<ReturnType<typeof build>>['app'];

const login = (app: TestApp, email: string, password: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/auth/login', headers: { ...JSON_HEADERS, ...headers }, payload: { email, password } });

const setCookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '');
const cookieHeader = (res: { headers: Record<string, unknown> }) => ({ cookie: setCookieOf(res).split(';')[0]! });

describe('POST /auth/login', () => {
  it('logs in and sets the session cookie with the right flags', async () => {
    await withApp(async ({ app, db }) => {
      const u = await createUsuario(db, { password: PASSWORD });
      const res = await login(app, u.email, PASSWORD);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: u.id, email: u.email, nombre: u.nombre });
      const cookie = setCookieOf(res);
      expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
      for (const flag of ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${config.SESSION_TTL_HOURS * 3600}`, 'Secure']) {
        expect(cookie).toContain(flag);
      }
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  it('omits Secure when the cookie is configured as non-secure (development)', async () => {
    await withApp(
      async ({ app, db }) => {
        const u = await createUsuario(db, { password: PASSWORD });
        expect(setCookieOf(await login(app, u.email, PASSWORD))).not.toContain('Secure');
      },
      { secureCookie: false },
    );
  });

  it('answers every credential failure with the identical 401', async () => {
    await withApp(async ({ app, db }) => {
      const wrong = await createUsuario(db, { password: PASSWORD });
      const noPassword = await createUsuario(db);
      const inactive = await createUsuario(db, { password: PASSWORD, activo: false });
      const locked = await createUsuario(db, { password: PASSWORD });
      for (let i = 0; i < 5; i++) await login(app, locked.email, 'wrong password!!');

      const attempts = [
        await login(app, 'nobody@example.test', PASSWORD),
        await login(app, wrong.email, 'wrong password!!'),
        await login(app, noPassword.email, PASSWORD),
        await login(app, inactive.email, PASSWORD),
        await login(app, locked.email, PASSWORD), // right password, but locked
      ];
      const first = attempts[0]!;
      expect(first.statusCode).toBe(401);
      expect(first.json()).toEqual({ error: 'invalid_credentials' });
      for (const res of attempts) {
        expect(res.statusCode).toBe(first.statusCode);
        expect(res.body).toBe(first.body);
        expect(res.headers['set-cookie']).toBeUndefined();
        const { date: _d, ...headers } = res.headers;
        const { date: _d0, ...firstHeaders } = first.headers;
        expect(headers).toEqual(firstHeaders);
      }
    });
  });

  it('five failed logins lock the account: the right password is then refused', async () => {
    await withApp(async ({ app, db }) => {
      const u = await createUsuario(db, { password: PASSWORD });
      for (let i = 0; i < 5; i++) expect((await login(app, u.email, 'wrong password!!')).statusCode).toBe(401);
      expect((await login(app, u.email, PASSWORD)).statusCode).toBe(401);
    });
  });

  it('rejects a malformed body with 400 and does not echo it', async () => {
    await withApp(async ({ app }) => {
      for (const payload of [{}, { email: 'a@example.test' }, { email: 1, password: 2 }]) {
        const res = await app.inject({ method: 'POST', url: '/auth/login', headers: JSON_HEADERS, payload });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_request' });
      }
      const broken = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: JSON_HEADERS,
        payload: '{"email":"a@example.test","password":"leaky-secret-123"',
      });
      expect(broken.statusCode).toBe(400);
      expect(broken.body).not.toContain('leaky-secret-123');
    });
  });

  it('revokes the old session when the request already carries a session cookie', async () => {
    await withApp(async ({ app, db }) => {
      const u = await createUsuario(db, { password: PASSWORD });
      const first = await login(app, u.email, PASSWORD);
      const old = cookieHeader(first);
      const second = await login(app, u.email, PASSWORD, old);
      expect(second.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/auth/me', headers: old })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/auth/me', headers: cookieHeader(second) })).statusCode).toBe(200);
    });
  });

  it('never writes the password to the logs', async () => {
    await withApp(async ({ app, db, logs }) => {
      const u = await createUsuario(db, { password: PASSWORD });
      await login(app, u.email, PASSWORD);
      await login(app, u.email, 'wrong-password-in-logs-test');
      await login(app, 'nobody@example.test', 'unknown-user-password-test');
      await app.inject({ method: 'POST', url: '/auth/login', headers: JSON_HEADERS, payload: { email: 'x@example.test', password: 12345678 } });
      await app.inject({ method: 'POST', url: '/auth/login', headers: JSON_HEADERS, payload: '{"password":"broken-json-password-test"' });
      expect(logs.length).toBeGreaterThan(0);
      const output = logs.join('\n');
      for (const secret of [PASSWORD, 'wrong-password-in-logs-test', 'unknown-user-password-test', 'broken-json-password-test']) {
        expect(output).not.toContain(secret);
      }
    });
  });
});

describe('GET /auth/me', () => {
  it('returns the user and roles with the cookie, never a hash', async () => {
    await withApp(async ({ app, db }) => {
      const u = await createUsuario(db, { password: PASSWORD });
      const cliente = await createCliente(db);
      await assignRole(db, { usuarioId: u.id, rolCodigo: 'dueno_cliente', clienteId: cliente.id });
      const res = await app.inject({ method: 'GET', url: '/auth/me', headers: cookieHeader(await login(app, u.email, PASSWORD)) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: u.id,
        email: u.email,
        nombre: u.nombre,
        roles: [{ rol: 'dueno_cliente', clienteId: cliente.id }],
      });
      expect(res.body).not.toContain('password');
    });
  });

  it('is 401 without a cookie and with a garbage cookie', async () => {
    await withApp(async ({ app }) => {
      expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
      const bad = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `${SESSION_COOKIE}=garbage` } });
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toEqual({ error: 'unauthorized' });
    });
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session, clears the cookie and answers 204', async () => {
    await withApp(async ({ app, db }) => {
      const u = await createUsuario(db, { password: PASSWORD });
      const headers = cookieHeader(await login(app, u.email, PASSWORD));
      const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { ...headers, ...JSON_HEADERS } });
      expect(out.statusCode).toBe(204);
      expect(setCookieOf(out)).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
      expect((await app.inject({ method: 'GET', url: '/auth/me', headers })).statusCode).toBe(401);
    });
  });

  it('answers 204 without a session', async () => {
    await withApp(async ({ app }) => {
      const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: JSON_HEADERS });
      expect(res.statusCode).toBe(204);
    });
  });
});

describe('CSRF guard', () => {
  it('rejects a wrong Origin and accepts the right one or none', async () => {
    await withApp(async ({ app, db }) => {
      const u = await createUsuario(db, { password: PASSWORD });
      const wrong = await login(app, u.email, PASSWORD, { origin: 'https://evil.example' });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toEqual({ error: 'forbidden_origin' });
      expect(wrong.headers['set-cookie']).toBeUndefined();
      expect((await login(app, u.email, PASSWORD, { origin: ORIGIN })).statusCode).toBe(200);
      expect((await login(app, u.email, PASSWORD)).statusCode).toBe(200);
    });
  });

  it('rejects non-JSON bodies with 415', async () => {
    await withApp(async ({ app }) => {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: { 'content-type': type },
          payload: 'email=a%40example.test&password=whatever12345',
        });
        expect(res.statusCode).toBe(415);
      }
      expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(415);
    });
  });

  it('does not apply to GET requests', async () => {
    await withApp(async ({ app }) => {
      const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { origin: 'https://evil.example' } });
      expect(res.statusCode).toBe(401); // reached the handler
    });
  });

  it('lets a route opt in to multipart, which still needs a matching Origin', async () => {
    await withApp(async ({ app }) => {
      app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
      app.post('/test/upload', { config: { csrf: { allowedContentTypes: ['multipart/form-data'] } } }, async () => ({ ok: true }));
      app.post('/test/plain', async () => ({ ok: true }));
      const multipart = { 'content-type': 'multipart/form-data; boundary=x' };

      expect((await app.inject({ method: 'POST', url: '/test/upload', headers: multipart, payload: 'data' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/test/upload', headers: { ...multipart, origin: ORIGIN }, payload: 'data' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/test/upload', headers: { 'content-type': 'text/plain' }, payload: 'data' })).statusCode).toBe(415);
      const wrongOrigin = await app.inject({ method: 'POST', url: '/test/upload', headers: { ...multipart, origin: 'https://evil.example' }, payload: 'data' });
      expect(wrongOrigin.statusCode).toBe(403);
      // The opt-in is per route: another route still rejects multipart.
      expect((await app.inject({ method: 'POST', url: '/test/plain', headers: multipart, payload: 'data' })).statusCode).toBe(415);
    });
  });
});
