import { scryptSync } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { getTestPool } from '../../../tests/utils/testPool.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { createUsuario } from '../../../tests/utils/factories/index.js';
import { config } from '../../config/index.js';
import type { Db } from '../../db/types.js';
import { hashPassword, PasswordPolicyError } from '../../lib/crypto/passwords.js';
import { createUsuario as createUsuarioRepo, setPassword, setUsuarioActivo, verifyCredentials } from './usuariosRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;
const PASSWORD = 'correct horse battery';
const WRONG = 'definitely not it!!';

const state = async (db: Db, id: string) =>
  (await db.query('SELECT intentos_fallidos, bloqueado_hasta, ultimo_login, password_hash FROM usuarios WHERE id = $1', [id])).rows[0];

async function fail(db: Db, email: string, times: number) {
  for (let i = 0; i < times; i++) expect(await verifyCredentials(db, email, WRONG)).toBeNull();
}

describe('verifyCredentials', () => {
  it('returns the user for the right password, with no hash in the result, and sets ultimo_login', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db, { password: PASSWORD });
      const found = await verifyCredentials(db, u.email.toUpperCase(), PASSWORD);
      expect(found?.id).toBe(u.id);
      expect(found).not.toHaveProperty('password_hash');
      expect((await state(db, u.id)).ultimo_login).not.toBeNull();
    });
  });

  it('fails identically for wrong password, unknown email, no password and inactive user', async () => {
    await withTestTransaction(async (db) => {
      const ok = await createUsuario(db, { password: PASSWORD });
      const noPassword = await createUsuario(db);
      const inactive = await createUsuario(db, { password: PASSWORD, activo: false });
      expect(await verifyCredentials(db, ok.email, WRONG)).toBeNull();
      expect(await verifyCredentials(db, 'nobody@example.test', PASSWORD)).toBeNull();
      expect(await verifyCredentials(db, noPassword.email, PASSWORD)).toBeNull();
      expect(await verifyCredentials(db, inactive.email, PASSWORD)).toBeNull();
    });
  });

  it('locks at the 5th failure and refuses even the right password while locked', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db, { password: PASSWORD });
      await fail(db, u.email, 4);
      expect((await state(db, u.id)).bloqueado_hasta).toBeNull();
      await fail(db, u.email, 1);
      const locked = await state(db, u.id);
      expect(locked.intentos_fallidos).toBe(5);
      expect(locked.bloqueado_hasta).not.toBeNull();
      expect(await verifyCredentials(db, u.email, PASSWORD)).toBeNull();
      // An active lock neither counts more failures nor extends the lock.
      await fail(db, u.email, 2);
      const after = await state(db, u.id);
      expect(after.intentos_fallidos).toBe(5);
      expect(after.bloqueado_hasta).toEqual(locked.bloqueado_hasta);
    });
  });

  it('unlocks once bloqueado_hasta has passed', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db, { password: PASSWORD });
      await fail(db, u.email, 5);
      await db.query("UPDATE usuarios SET bloqueado_hasta = now() - interval '1 second' WHERE id = $1", [u.id]);
      expect((await verifyCredentials(db, u.email, PASSWORD))?.id).toBe(u.id);
      expect(await state(db, u.id)).toMatchObject({ intentos_fallidos: 0, bloqueado_hasta: null });
    });
  });

  it('after an expired lock, one failure restarts the count and does not lock', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db, { password: PASSWORD });
      await fail(db, u.email, 5);
      await db.query("UPDATE usuarios SET bloqueado_hasta = now() - interval '1 second' WHERE id = $1", [u.id]);
      await fail(db, u.email, 1);
      expect(await state(db, u.id)).toMatchObject({ intentos_fallidos: 1, bloqueado_hasta: null });
      expect((await verifyCredentials(db, u.email, PASSWORD))?.id).toBe(u.id);
    });
  });

  it('a success resets the failure counter', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db, { password: PASSWORD });
      await fail(db, u.email, 3);
      expect((await state(db, u.id)).intentos_fallidos).toBe(3);
      await verifyCredentials(db, u.email, PASSWORD);
      expect((await state(db, u.id)).intentos_fallidos).toBe(0);
    });
  });

  it('rehashes at the current cost on a successful login, without auditing it', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db);
      const lowN = 2 ** (config.PASSWORD_SCRYPT_LOG_N - 1);
      const salt = Buffer.alloc(16, 7);
      const key = scryptSync(PASSWORD, salt, 32, { N: lowN, r: 8, p: 1 });
      const old = `scrypt$${lowN}$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
      await db.query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [u.id, old]);
      expect((await verifyCredentials(db, u.email, PASSWORD))?.id).toBe(u.id);
      const stored = (await state(db, u.id)).password_hash as string;
      expect(stored).not.toBe(old);
      expect(Number(stored.split('$')[1])).toBe(2 ** config.PASSWORD_SCRYPT_LOG_N);
      // Still valid, and a second login keeps the hash as is.
      expect((await verifyCredentials(db, u.email, PASSWORD))?.id).toBe(u.id);
      expect((await state(db, u.id)).password_hash).toBe(stored);
      expect(await auditRowsFor(db, 'usuarios', u.id)).toEqual([]);
    });
  });

  it('does not rehash when the password is wrong', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db, { password: PASSWORD });
      const before = (await state(db, u.id)).password_hash;
      await fail(db, u.email, 1);
      expect((await state(db, u.id)).password_hash).toBe(before);
    });
  });
});

describe('setPassword and audit', () => {
  it('sets the password, clears the lockout and enforces the policy', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db, { password: PASSWORD });
      await fail(db, u.email, 5);
      await expect(setPassword(db, u.id, 'too short', SISTEMA)).rejects.toThrow(PasswordPolicyError);
      const updated = await setPassword(db, u.id, 'a brand new password', SISTEMA);
      expect(updated).not.toHaveProperty('password_hash');
      expect(await state(db, u.id)).toMatchObject({ intentos_fallidos: 0, bloqueado_hasta: null });
      expect(await verifyCredentials(db, u.email, PASSWORD)).toBeNull();
      expect((await verifyCredentials(db, u.email, 'a brand new password'))?.id).toBe(u.id);
      expect(await setPassword(db, '00000000-0000-4000-8000-000000000000', 'a brand new password', SISTEMA)).toBeNull();
    });
  });

  it('audits password changes and lockouts, and no hash or password reaches auditoria', async () => {
    await withTestTransaction(async (db) => {
      const created = await createUsuarioRepo(db, { email: `audit-${Date.now()}@example.test`, nombre: 'Auditado' }, SISTEMA);
      await setPassword(db, created.id, PASSWORD, SISTEMA);
      await setUsuarioActivo(db, created.id, false, SISTEMA);
      await setUsuarioActivo(db, created.id, true, SISTEMA);
      await fail(db, created.email, 5);
      const hash = (await state(db, created.id)).password_hash as string;
      const audit = await auditRowsFor(db, 'usuarios', created.id);
      expect(audit.map((a) => a.accion)).toEqual([
        'crear',
        'cambiar_password',
        'cambiar_activo',
        'cambiar_activo',
        'bloquear_cuenta',
      ]);
      expect(audit[1]!.datos_despues).toEqual({ password_changed: true });
      const dump = JSON.stringify(audit);
      expect(dump).not.toContain(hash);
      expect(dump).not.toContain(PASSWORD);
      expect(dump).not.toContain('password_hash');
    });
  });
});

describe('concurrent failed logins', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  });
  afterAll(async () => {
    await cleanupDomainTables(getTestPool());
    await pool.end();
  });

  it('5 parallel wrong passwords on separate connections leave 5 failures and a locked account', async () => {
    await cleanupDomainTables(getTestPool());
    const hash = await hashPassword(PASSWORD);
    const { rows } = await pool.query(
      "INSERT INTO usuarios (email, nombre, password_hash) VALUES ('concurrent@example.test', 'Concurrente', $1) RETURNING id, email",
      [hash],
    );
    const { id, email } = rows[0];
    const results = await Promise.all(Array.from({ length: 5 }, () => verifyCredentials(pool, email, WRONG)));
    expect(results.every((r) => r === null)).toBe(true);
    expect(await state(pool, id)).toMatchObject({ intentos_fallidos: 5 });
    expect((await state(pool, id)).bloqueado_hasta).not.toBeNull();
    expect((await auditRowsFor(pool, 'usuarios', id)).filter((a) => a.accion === 'bloquear_cuenta')).toHaveLength(1);
  });
});
