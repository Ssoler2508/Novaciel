import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/types.js';
import { getUserRoles, type UserRole } from '../roles/usuarioRolesRepository.js';
import { validateSession } from '../sesiones/sesionesRepository.js';
import type { UsuarioRow } from '../usuarios/usuariosRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import { SESSION_COOKIE } from './cookie.js';
import { can, PERMISSIONS, type Action } from './permissions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireSession / requirePermission. */
    auth?: { user: UsuarioRow; roles: UserRole[] };
  }
}

// These hooks read the session cookie, so registerAuth (which registers @fastify/cookie and the
// CSRF guard) must have run on the app first.

type Hook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type ClienteIdGetter = (req: FastifyRequest) => string | null | undefined | Promise<string | null | undefined>;

/**
 * Loads the user and their roles from the session cookie, or answers 401. Roles are read on every
 * request, so a revoked or granted assignment takes effect on the next request.
 */
export function requireSession(db: Db): Hook {
  return async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const user = token ? await validateSession(db, token) : null;
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    req.auth = { user, roles: await getUserRoles(db, user.id) };
  };
}

/** A malformed id counts as no id, so even a NovaCiel role cannot pass with garbage. */
function validClienteId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return asClienteId(value);
  } catch {
    return undefined;
  }
}

/**
 * 401 without a valid session, 403 unless the user's roles grant `action`.
 * For client-scoped actions `getClienteId` says which client the request is about; a missing or
 * unusable id is a 403. Global actions take no getter.
 */
export function requirePermission(db: Db, action: Action, getClienteId?: ClienteIdGetter): Hook {
  const session = requireSession(db);
  const scope = PERMISSIONS[action].scope;
  return async (req, reply) => {
    await session(req, reply);
    if (reply.sent) return;
    const clienteId = scope === 'client' && getClienteId ? validClienteId(await getClienteId(req)) : undefined;
    if (!can(req.auth!.roles, action, clienteId)) return reply.code(403).send({ error: 'forbidden' });
  };
}
