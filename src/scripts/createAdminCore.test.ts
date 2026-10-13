import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createSesion, createUsuario } from '../../tests/utils/factories/index.js';
import { PasswordPolicyError } from '../lib/crypto/passwords.js';
import { validateSession } from '../modules/sesiones/sesionesRepository.js';
import { verifyCredentials } from '../modules/usuarios/usuariosRepository.js';
import { hasNovaCielRole } from '../modules/roles/usuarioRolesRepository.js';
import { createOrUpdateAdmin, DEFAULT_ADMIN_NAME } from './createAdminCore.js';

const PASSWORD = 'a fictional admin password';
const NEW_PASSWORD = 'another fictional password';

const auditFor = async (db: Parameters<typeof createOrUpdateAdmin>[0], usuarioId: string) =>
  (await db.query("SELECT * FROM auditoria WHERE (tabla = 'usuarios' AND fila_id = $1) OR (datos_despues->>'usuario_id' = $1) ORDER BY id", [usuarioId]))
    .rows;

describe('createOrUpdateAdmin', () => {
  it('creates the user with the role and a password that can log in', async () => {
    await withTestTransaction(async (db) => {
      const email = 'nuevo-admin@example.test';
      const result = await createOrUpdateAdmin(db, { email, password: PASSWORD });
      expect(result).toMatchObject({ created: true, reactivated: false, roleAssigned: true });
      expect(await hasNovaCielRole(db, result.usuarioId, 'administrador_novaciel')).toBe(true);
      const user = await verifyCredentials(db, email.toUpperCase(), PASSWORD);
      expect(user).toMatchObject({ id: result.usuarioId, nombre: DEFAULT_ADMIN_NAME });
    });
  });

  it('updates an existing user: new password, no duplicate role, name kept, sessions revoked, lockout cleared', async () => {
    await withTestTransaction(async (db) => {
      const existing = await createUsuario(db, { password: PASSWORD, nombre: 'Nombre Original' });
      await createOrUpdateAdmin(db, { email: existing.email, password: PASSWORD });
      const session = await createSesion(db, { usuarioId: existing.id });
      await db.query("UPDATE usuarios SET intentos_fallidos = 5, bloqueado_hasta = now() + interval '10 minutes' WHERE id = $1", [existing.id]);

      const result = await createOrUpdateAdmin(db, { email: existing.email, nombre: 'Otro Nombre', password: NEW_PASSWORD });
      expect(result).toMatchObject({ usuarioId: existing.id, created: false, roleAssigned: false });
      const roles = await db.query('SELECT 1 FROM usuario_roles WHERE usuario_id = $1', [existing.id]);
      expect(roles.rows).toHaveLength(1);
      expect(await validateSession(db, session.token)).toBeNull();
      expect(await verifyCredentials(db, existing.email, PASSWORD)).toBeNull();
      expect(await verifyCredentials(db, existing.email, NEW_PASSWORD)).toMatchObject({ id: existing.id, nombre: 'Nombre Original' });
    });
  });

  it('reactivates an inactive user', async () => {
    await withTestTransaction(async (db) => {
      const inactive = await createUsuario(db, { activo: false });
      const result = await createOrUpdateAdmin(db, { email: inactive.email, password: PASSWORD });
      expect(result.reactivated).toBe(true);
      expect(await verifyCredentials(db, inactive.email, PASSWORD)).not.toBeNull();
    });
  });

  it('refuses a weak password and writes nothing', async () => {
    await withTestTransaction(async (db) => {
      await expect(createOrUpdateAdmin(db, { email: 'weak@example.test', password: 'short' })).rejects.toThrow(PasswordPolicyError);
      const { rows } = await db.query("SELECT 1 FROM usuarios WHERE email = 'weak@example.test'");
      expect(rows).toEqual([]);
    });
  });

  it('audits as sistema, with no password and no hash', async () => {
    await withTestTransaction(async (db) => {
      const result = await createOrUpdateAdmin(db, { email: 'audit-admin@example.test', password: PASSWORD });
      await createOrUpdateAdmin(db, { email: 'audit-admin@example.test', password: NEW_PASSWORD });
      const hash = (await db.query('SELECT password_hash FROM usuarios WHERE id = $1', [result.usuarioId])).rows[0].password_hash as string;
      const rows = await auditFor(db, result.usuarioId);
      const own = rows.filter((r) => r.tabla === 'usuarios');
      expect(own.map((r) => r.accion)).toEqual(['crear', 'cambiar_password', 'cambiar_password']);
      expect(rows.every((r) => r.actor_tipo === 'sistema')).toBe(true);
      const dump = JSON.stringify(rows);
      for (const secret of [PASSWORD, NEW_PASSWORD, hash, 'password_hash']) expect(dump).not.toContain(secret);
    });
  });
});
