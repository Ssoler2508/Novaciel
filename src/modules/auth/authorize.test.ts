import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { assignRole, createCliente, createSesion, createUsuario } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { asClienteId } from '../shared/clienteId.js';
import { assignClientRole, revokeClientRole } from '../roles/usuarioRolesRepository.js';
import { setUsuarioActivo } from '../usuarios/usuariosRepository.js';
import { revokeSession } from '../sesiones/sesionesRepository.js';
import { registerAuth } from './authRoutes.js';
import { requirePermission, requireSession } from './authorize.js';
import { SESSION_COOKIE } from './cookie.js';
import { ACTIONS, PERMISSIONS, ROLE_CODES, type Action, type RoleCode } from './permissions.js';

// Same strategy as authRoutes.test.ts: the single client of withTestTransaction is the Db, so
// everything rolls back and no cleanup helper is needed.

const SISTEMA = { tipo: 'sistema' } as const;
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];

async function buildApp(db: Db) {
  const app = Fastify();
  await registerAuth(app, { db, allowedOrigin: 'http://localhost:3999' });
  app.get('/test/session', { preHandler: requireSession(db) }, async (req) => ({ id: req.auth!.user.id }));
  for (const action of ACTIONS) {
    if (PERMISSIONS[action].scope === 'global') {
      app.get(`/test/global/${action}`, { preHandler: requirePermission(db, action) }, async () => ({ ok: true }));
    } else {
      app.get<{ Params: { clienteId: string } }>(
        `/test/clients/:clienteId/${action}`,
        { preHandler: requirePermission(db, action, (req) => (req.params as { clienteId: string }).clienteId) },
        async () => ({ ok: true }),
      );
    }
  }
  return app;
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function withApp(fn: (ctx: { app: TestApp; db: Db }) => Promise<void>) {
  await withTestTransaction(async (db) => {
    const app = await buildApp(db);
    try {
      await fn({ app, db });
    } finally {
      await app.close();
    }
  });
}

/** A user holding `rol` (for `clienteId`, unless it is a NovaCiel role) and a live session cookie. */
async function userWith(db: Db, rol: RoleCode, clienteId: string | null) {
  const u = await createUsuario(db);
  await assignRole(db, { usuarioId: u.id, rolCodigo: rol, clienteId: NOVACIEL.includes(rol) ? null : clienteId });
  const s = await createSesion(db, { usuarioId: u.id });
  return { usuario: u, cookie: { cookie: `${SESSION_COOKIE}=${s.token}` } };
}

const call = (app: TestApp, action: Action, clienteId: string | undefined, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url: PERMISSIONS[action].scope === 'global' ? `/test/global/${action}` : `/test/clients/${clienteId}/${action}`,
    headers,
  });

describe('requireSession', () => {
  it('loads the user from a valid cookie and answers 401 otherwise', async () => {
    await withApp(async ({ app, db }) => {
      const cliente = await createCliente(db);
      const { usuario, cookie } = await userWith(db, 'dueno_cliente', cliente.id);
      const ok = await app.inject({ method: 'GET', url: '/test/session', headers: cookie });
      expect(ok.json()).toEqual({ id: usuario.id });
      for (const headers of [{}, { cookie: `${SESSION_COOKIE}=garbage` }]) {
        const res = await app.inject({ method: 'GET', url: '/test/session', headers });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'unauthorized' });
      }
    });
  });
});

describe('requirePermission: every role on every action', () => {
  // Expected answers per action, restated here independently of the data file.
  const allowedRoles: Record<Action, RoleCode[]> = {
    read_client_data: ['administrador_novaciel', 'operador_novaciel', 'dueno_cliente', 'aprobador_cliente'],
    edit_brand_profile: ['administrador_novaciel', 'operador_novaciel', 'dueno_cliente'],
    upload_material: [...ROLE_CODES],
    approve_internal: ['administrador_novaciel', 'operador_novaciel'],
    approve_as_client: ['dueno_cliente', 'aprobador_cliente'],
    manage_connections: ['administrador_novaciel', 'dueno_cliente'],
    manage_users: ['administrador_novaciel', 'dueno_cliente'],
    manage_plans: ['administrador_novaciel', 'operador_novaciel'],
    view_spend: ['administrador_novaciel', 'operador_novaciel'],
    manage_budget: ['administrador_novaciel'],
    manage_novaciel_staff: ['administrador_novaciel'],
  };

  it('answers 200 for allowed roles and 403 for the others (one case each, for all 5 roles)', async () => {
    await withApp(async ({ app, db }) => {
      const cliente = await createCliente(db);
      const users = new Map<RoleCode, { cookie: { cookie: string } }>();
      for (const rol of ROLE_CODES) users.set(rol, await userWith(db, rol, cliente.id));
      for (const action of ACTIONS) {
        for (const rol of ROLE_CODES) {
          const res = await call(app, action, cliente.id, users.get(rol)!.cookie);
          const expected = allowedRoles[action].includes(rol) ? 200 : 403;
          expect(res.statusCode, `${rol} on ${action}`).toBe(expected);
          if (expected === 403) expect(res.json()).toEqual({ error: 'forbidden' });
        }
      }
    });
  });

  it('no session gets 401 on every action', async () => {
    await withApp(async ({ app, db }) => {
      const cliente = await createCliente(db);
      for (const action of ACTIONS) {
        expect((await call(app, action, cliente.id)).statusCode, action).toBe(401);
      }
    });
  });
});

describe('requirePermission: client scoping', () => {
  it('a client role for client A gets 403 on client B, for every client action it holds', async () => {
    await withApp(async ({ app, db }) => {
      const a = await createCliente(db);
      const b = await createCliente(db);
      for (const rol of ['dueno_cliente', 'aprobador_cliente', 'colaborador_cliente'] as const) {
        const { cookie } = await userWith(db, rol, a.id);
        for (const action of ACTIONS.filter((x) => PERMISSIONS[x].scope === 'client' && PERMISSIONS[x].roles.includes(rol))) {
          expect((await call(app, action, a.id, cookie)).statusCode, `${rol} ${action} own`).toBe(200);
          expect((await call(app, action, b.id, cookie)).statusCode, `${rol} ${action} other`).toBe(403);
        }
      }
    });
  });

  it('NovaCiel roles pass for any client', async () => {
    await withApp(async ({ app, db }) => {
      const a = await createCliente(db);
      const b = await createCliente(db);
      const { cookie } = await userWith(db, 'operador_novaciel', null);
      for (const client of [a, b]) expect((await call(app, 'approve_internal', client.id, cookie)).statusCode).toBe(200);
    });
  });

  it('a user with different roles in two clients gets the right rights in each', async () => {
    await withApp(async ({ app, db }) => {
      const a = await createCliente(db);
      const b = await createCliente(db);
      const { usuario, cookie } = await userWith(db, 'dueno_cliente', a.id);
      await assignRole(db, { usuarioId: usuario.id, rolCodigo: 'colaborador_cliente', clienteId: b.id });
      expect((await call(app, 'manage_users', a.id, cookie)).statusCode).toBe(200);
      expect((await call(app, 'manage_users', b.id, cookie)).statusCode).toBe(403);
      expect((await call(app, 'upload_material', b.id, cookie)).statusCode).toBe(200);
    });
  });

  it('a user with no roles gets 403, and a missing or malformed client id is 403', async () => {
    await withApp(async ({ app, db }) => {
      const cliente = await createCliente(db);
      const nobody = await createUsuario(db);
      const nobodyCookie = { cookie: `${SESSION_COOKIE}=${(await createSesion(db, { usuarioId: nobody.id })).token}` };
      expect((await call(app, 'upload_material', cliente.id, nobodyCookie)).statusCode).toBe(403);
      const { cookie } = await userWith(db, 'administrador_novaciel', null);
      for (const bad of ['not-a-uuid', '00000000']) {
        expect((await call(app, 'read_client_data', bad, cookie)).statusCode).toBe(403);
      }
      expect((await call(app, 'read_client_data', cliente.id, cookie)).statusCode).toBe(200);
    });
  });
});

describe('requirePermission: sessions and role changes', () => {
  it('a revoked role assignment takes effect on the next request, and a new one too', async () => {
    await withApp(async ({ app, db }) => {
      const cliente = await createCliente(db);
      const clienteId = asClienteId(cliente.id);
      const { usuario, cookie } = await userWith(db, 'aprobador_cliente', cliente.id);
      expect((await call(app, 'approve_as_client', cliente.id, cookie)).statusCode).toBe(200);
      expect(await revokeClientRole(db, clienteId, { usuarioId: usuario.id, rolCodigo: 'aprobador_cliente' }, SISTEMA)).toBe(true);
      expect((await call(app, 'approve_as_client', cliente.id, cookie)).statusCode).toBe(403);
      await assignClientRole(db, clienteId, { usuarioId: usuario.id, rolCodigo: 'aprobador_cliente' }, SISTEMA);
      expect((await call(app, 'approve_as_client', cliente.id, cookie)).statusCode).toBe(200);
    });
  });

  it('revoked sessions and deactivated users get 401', async () => {
    await withApp(async ({ app, db }) => {
      const cliente = await createCliente(db);
      const revoked = await userWith(db, 'dueno_cliente', cliente.id);
      const token = revoked.cookie.cookie.split('=')[1]!;
      expect(await revokeSession(db, token)).toBe(true);
      expect((await call(app, 'read_client_data', cliente.id, revoked.cookie)).statusCode).toBe(401);

      const inactive = await userWith(db, 'dueno_cliente', cliente.id);
      await db.query('UPDATE usuarios SET activo = false WHERE id = $1', [inactive.usuario.id]);
      expect((await call(app, 'read_client_data', cliente.id, inactive.cookie)).statusCode).toBe(401);
      await setUsuarioActivo(db, inactive.usuario.id, true, SISTEMA);
      // The raw SQL above did not go through setUsuarioActivo, so the session was never revoked.
      expect((await call(app, 'read_client_data', cliente.id, inactive.cookie)).statusCode).toBe(200);
    });
  });
});
