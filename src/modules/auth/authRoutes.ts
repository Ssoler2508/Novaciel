import fastifyCookie from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../../config/index.js';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { getUserRoles } from '../roles/usuarioRolesRepository.js';
import { createSession, revokeSession, validateSession } from '../sesiones/sesionesRepository.js';
import { verifyCredentials } from '../usuarios/usuariosRepository.js';
import type { App } from './appType.js';
import { SESSION_COOKIE, sessionCookieOptions, sessionMaxAgeSeconds } from './cookie.js';
import { createCsrfGuard } from './csrf.js';

export interface AuthOptions {
  db: Db;
  /** Defaults to the origin of PUBLIC_BASE_URL (or http://localhost:PORT). */
  allowedOrigin?: string;
  /** Defaults to true outside development. */
  secureCookie?: boolean;
}

// Only the shape is validated: no password policy at login, and the input is never echoed back.
const loginBody = z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024) });

export function defaultAllowedOrigin(): string {
  return new URL(config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`).origin;
}

/**
 * Registers cookie parsing, the app-wide CSRF guard and the /auth routes.
 * Call it before registering other state-changing routes so the guard covers them.
 */
export async function registerAuth(app: App, options: AuthOptions): Promise<void> {
  const { db } = options;
  const secure = options.secureCookie ?? config.NODE_ENV !== 'development';

  await app.register(fastifyCookie);

  // JSON parser with a fixed error text: the default one quotes a piece of the body, which for
  // /auth/login could be the password. An empty body counts as {} (logout is called without one).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }), undefined);
    }
  });

  app.addHook('onRequest', createCsrfGuard(options.allowedOrigin ?? defaultAllowedOrigin()));
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/auth/')) reply.header('Cache-Control', 'no-store');
  });

  const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: 'unauthorized' });

  app.post('/auth/login', async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });

    const user = await verifyCredentials(db, body.data.email, body.data.password);
    // One answer for every reason: unknown email, wrong password, locked, inactive, no password.
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });

    const { token } = await runInTransaction(db, async (tx) => {
      const previous = req.cookies[SESSION_COOKIE];
      if (previous) await revokeSession(tx, previous); // never leave the old session alive
      return createSession(tx, user.id);
    });
    reply.setCookie(SESSION_COOKIE, token, { ...sessionCookieOptions(secure), maxAge: sessionMaxAgeSeconds() });
    return { id: user.id, email: user.email, nombre: user.nombre };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await revokeSession(db, token);
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(secure));
    return reply.code(204).send();
  });

  app.get('/auth/me', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await validateSession(db, token) : null;
    if (!user) return unauthorized(reply);
    return { id: user.id, email: user.email, nombre: user.nombre, roles: await getUserRoles(db, user.id) };
  });
}
