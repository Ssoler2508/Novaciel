import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { createSesion, createUsuario } from '../../../tests/utils/factories/index.js';
import { config } from '../../config/index.js';
import type { Db } from '../../db/types.js';
import { setPassword, setUsuarioActivo } from '../usuarios/usuariosRepository.js';
import { createSession, revokeAllSessions, revokeSession, validateSession } from './sesionesRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;

const row = async (db: Db, id: string) =>
  (await db.query('SELECT ultimo_uso, revocada_en, ctid::text AS ctid FROM sesiones WHERE id = $1', [id])).rows[0];

const sessionAudit = async (db: Db, usuarioId: string) =>
  (await db.query("SELECT * FROM auditoria WHERE tabla = 'sesiones' ORDER BY id")).rows.filter(
    (a) => JSON.stringify(a).includes(usuarioId),
  );

describe('createSession', () => {
  it('stores only the SHA-256 of the token and returns the plain token once', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db);
      const { token, sesionId, expiraEn } = await createSession(db, u.id);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = (await db.query('SELECT * FROM sesiones WHERE id = $1', [sesionId])).rows[0];
      expect(stored.token_hash.equals(createHash('sha256').update(token).digest())).toBe(true);
      const asText = Object.values(stored)
        .map((v) => (Buffer.isBuffer(v) ? `${v.toString('latin1')}|${v.toString('hex')}|${v.toString('base64')}` : String(v)))
        .join('|');
      expect(asText).not.toContain(token);
      const hours = (expiraEn.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(config.SESSION_TTL_HOURS - 0.1);
      expect(hours).toBeLessThanOrEqual(config.SESSION_TTL_HOURS);
    });
  });
});

describe('validateSession', () => {
  it('returns the user (without hash) for a valid token and null for garbage', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db, { password: 'correct horse battery' });
      const { token } = await createSession(db, u.id);
      const found = await validateSession(db, token);
      expect(found).toMatchObject({ id: u.id, email: u.email });
      expect(found).not.toHaveProperty('password_hash');
      expect(found).not.toHaveProperty('sesion_id');
      for (const bad of ['', 'nonsense', `${token}x`, token.slice(1)]) expect(await validateSession(db, bad)).toBeNull();
    });
  });

  it('refreshes ultimo_uso at most once per 60 seconds', async () => {
    await withTestTransaction(async (db) => {
      const fresh = await createSesion(db);
      const freshBefore = await row(db, fresh.id);
      await validateSession(db, fresh.token);
      await validateSession(db, fresh.token);
      expect(await row(db, fresh.id)).toEqual(freshBefore);

      const old = await createSesion(db, { ultimoUsoHaceSegundos: 61 });
      const before = await row(db, old.id);
      await validateSession(db, old.token);
      const first = await row(db, old.id);
      expect(first.ultimo_uso.getTime()).toBeGreaterThan(before.ultimo_uso.getTime());
      await validateSession(db, old.token);
      expect(await row(db, old.id)).toEqual(first); // same value and same physical row: no second write
    });
  });

  it('rejects expired, idle and revoked sessions', async () => {
    await withTestTransaction(async (db) => {
      const expired = await createSesion(db, { expiraEnSegundos: -1 });
      const idle = await createSesion(db, { ultimoUsoHaceSegundos: config.SESSION_IDLE_MINUTES * 60 + 5 });
      const revoked = await createSesion(db, { revoked: true });
      const ok = await createSesion(db, { ultimoUsoHaceSegundos: config.SESSION_IDLE_MINUTES * 60 - 30 });
      expect(await validateSession(db, expired.token)).toBeNull();
      expect(await validateSession(db, idle.token)).toBeNull();
      expect(await validateSession(db, revoked.token)).toBeNull();
      expect(await validateSession(db, ok.token)).not.toBeNull();
    });
  });
});

describe('revocation', () => {
  it('revokeSession revokes one session; two sessions of a user are independent', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db);
      const a = await createSession(db, u.id);
      const b = await createSession(db, u.id);
      expect(await revokeSession(db, a.token)).toBe(true);
      expect(await validateSession(db, a.token)).toBeNull();
      expect(await validateSession(db, b.token)).not.toBeNull();
      expect(await revokeSession(db, a.token)).toBe(false);
      expect(await revokeSession(db, 'unknown-token')).toBe(false);
    });
  });

  it('deactivating a user revokes its sessions and reactivating does not revive them', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db);
      const other = await createUsuario(db);
      const s = await createSession(db, u.id);
      const otherSession = await createSession(db, other.id);
      await setUsuarioActivo(db, u.id, false, SISTEMA);
      expect(await validateSession(db, s.token)).toBeNull();
      await setUsuarioActivo(db, u.id, true, SISTEMA);
      expect(await validateSession(db, s.token)).toBeNull();
      expect((await row(db, s.sesionId)).revocada_en).not.toBeNull();
      const fresh = await createSession(db, u.id);
      expect(await validateSession(db, fresh.token)).not.toBeNull();
      expect(await validateSession(db, otherSession.token)).not.toBeNull();
    });
  });

  it('a password change revokes all sessions of that user only', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db, { password: 'correct horse battery' });
      const other = await createUsuario(db);
      const a = await createSession(db, u.id);
      const b = await createSession(db, u.id);
      const o = await createSession(db, other.id);
      await setPassword(db, u.id, 'a brand new password', SISTEMA);
      expect(await validateSession(db, a.token)).toBeNull();
      expect(await validateSession(db, b.token)).toBeNull();
      expect(await validateSession(db, o.token)).not.toBeNull();
    });
  });

  it('revokeAllSessions returns the count and writes no audit row when there is nothing to revoke', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db);
      expect(await revokeAllSessions(db, u.id, SISTEMA)).toBe(0);
      expect(await sessionAudit(db, u.id)).toEqual([]);
      await createSession(db, u.id);
      await createSession(db, u.id);
      expect(await revokeAllSessions(db, u.id, SISTEMA)).toBe(2);
      expect(await revokeAllSessions(db, u.id, SISTEMA)).toBe(0);
    });
  });
});

describe('audit', () => {
  it('records create, revoke and revoke-all without the token or its hash', async () => {
    await withTestTransaction(async (db) => {
      const u = await createUsuario(db);
      const a = await createSession(db, u.id);
      const b = await createSession(db, u.id);
      await revokeSession(db, a.token);
      await revokeAllSessions(db, u.id, SISTEMA);
      const audit = await sessionAudit(db, u.id);
      expect(audit.map((x) => x.accion)).toEqual(['crear', 'crear', 'revocar', 'revocar_todas']);
      expect(audit[3].datos_despues).toMatchObject({ cantidad: 1 });
      const dump = JSON.stringify(audit);
      for (const token of [a.token, b.token]) {
        const hash = createHash('sha256').update(token).digest();
        for (const needle of [token, hash.toString('hex'), hash.toString('base64'), hash.toString('base64url')]) {
          expect(dump).not.toContain(needle);
        }
      }
      expect((await auditRowsFor(db, 'sesiones', a.sesionId)).map((x) => x.accion)).toEqual(['crear', 'revocar']);
    });
  });
});
