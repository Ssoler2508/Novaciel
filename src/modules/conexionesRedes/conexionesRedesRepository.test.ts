import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { createCliente, createConexionRed, createUsuario } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { decryptSecret, SecretsError } from '../../lib/crypto/secrets.js';
import { asClienteId } from '../shared/clienteId.js';
import {
  ConexionActivaExistsError,
  ConexionActorError,
  ConexionNotFoundError,
  createConexion,
  getSecretForUse,
  listConexiones,
  revokeConexion,
  rotateConexion,
  secretContext,
} from './conexionesRedesRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;
const SECRET = JSON.stringify({ access_token: 'fake-access-token-9f3a', refresh_token: 'fake-refresh-token-77c1' });

async function setup(db: Db) {
  const clienteId = asClienteId((await createCliente(db)).id);
  const usuario = await createUsuario(db);
  return { clienteId, actor: { tipo: 'usuario', usuarioId: usuario.id } as const };
}

/** Every secret-bearing value an audit row must never contain. */
function secretNeedles(row: { secreto_cifrado: Buffer; secreto_iv: Buffer; secreto_tag: Buffer }, plain: string[]): string[] {
  return [
    ...plain,
    ...[row.secreto_cifrado, row.secreto_iv, row.secreto_tag].flatMap((b) => [b.toString('hex'), b.toString('base64')]),
  ];
}

describe('conexionesRedesRepository', () => {
  it('create stores no plaintext in any column and getSecretForUse returns it', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, actor } = await setup(db);
      const meta = await createConexion(db, clienteId, { red: 'instagram', etiqueta: '@cafe_ficticio', secreto: SECRET }, actor);
      expect(meta).not.toHaveProperty('secreto_cifrado');
      const raw = (await db.query('SELECT * FROM conexiones_redes WHERE id = $1', [meta.id])).rows[0];
      const asText = Object.values(raw)
        .map((v) => (Buffer.isBuffer(v) ? v.toString('latin1') : String(v)))
        .join('|');
      expect(asText).not.toContain('fake-access-token');
      expect(asText).not.toContain('fake-refresh-token');
      expect(raw.secreto_version_clave).toBe(1);
      expect(await getSecretForUse(db, clienteId, meta.id)).toBe(SECRET);
    });
  });

  it('listConexiones returns metadata only, including expira_en', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, actor } = await setup(db);
      const expiraEn = new Date('2030-01-01T00:00:00Z');
      await createConexion(db, clienteId, { red: 'tiktok', etiqueta: '@t', secreto: SECRET, expiraEn }, actor);
      const list = await listConexiones(db, clienteId);
      expect(list).toHaveLength(1);
      expect(list[0]!.expira_en).toEqual(expiraEn);
      expect(Object.keys(list[0]!).filter((k) => k.startsWith('secreto_'))).toEqual(['secreto_version_clave']);
      expect(JSON.stringify(list)).not.toContain('fake-access-token');
    });
  });

  it('create rejects the sistema actor', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await setup(db);
      await expect(createConexion(db, clienteId, { red: 'facebook', etiqueta: 'x', secreto: SECRET }, SISTEMA)).rejects.toThrow(
        ConexionActorError,
      );
    });
  });

  it('allows one active connection per client and network; other clients and networks are free', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, actor } = await setup(db);
      await createConexion(db, clienteId, { red: 'instagram', etiqueta: 'a', secreto: 's1' }, actor);
      await expect(createConexion(db, clienteId, { red: 'instagram', etiqueta: 'b', secreto: 's2' }, actor)).rejects.toThrow(
        ConexionActivaExistsError,
      );
      await createConexion(db, clienteId, { red: 'facebook', etiqueta: 'c', secreto: 's3' }, actor);
      const other = await setup(db);
      await createConexion(db, other.clienteId, { red: 'instagram', etiqueta: 'd', secreto: 's4' }, other.actor);
    });
  });

  it('a row copied to another client or network fails to decrypt', async () => {
    await withTestTransaction(async (db) => {
      const src = await createConexionRed(db, { red: 'instagram' });
      const otherClient = await createCliente(db);
      const copy = (
        await db.query('UPDATE conexiones_redes SET cliente_id = $2 WHERE id = $1 RETURNING *', [src.id, otherClient.id])
      ).rows[0];
      const enc = {
        ciphertext: copy.secreto_cifrado,
        iv: copy.secreto_iv,
        authTag: copy.secreto_tag,
        keyVersion: copy.secreto_version_clave,
      };
      expect(() => decryptSecret(enc, secretContext(otherClient.id, 'instagram'))).toThrow(SecretsError);
      await expect(getSecretForUse(db, asClienteId(otherClient.id), src.id)).rejects.toThrow(SecretsError);
      await db.query("UPDATE conexiones_redes SET red = 'tiktok' WHERE id = $1", [src.id]);
      await expect(getSecretForUse(db, asClienteId(otherClient.id), src.id)).rejects.toThrow(SecretsError);
    });
  });

  it('a revoked connection cannot be used or rotated; revoking twice is a no-op; reconnecting works', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, actor } = await setup(db);
      const meta = await createConexion(db, clienteId, { red: 'youtube', etiqueta: 'y', secreto: SECRET }, actor);
      const revoked = await revokeConexion(db, clienteId, meta.id, actor);
      expect(revoked?.revocada_en).not.toBeNull();
      await expect(getSecretForUse(db, clienteId, meta.id)).rejects.toThrow(ConexionNotFoundError);
      await expect(rotateConexion(db, clienteId, meta.id, 'new', actor)).rejects.toThrow(ConexionNotFoundError);
      expect(await revokeConexion(db, clienteId, meta.id, actor)).toBeNull();
      expect((await auditRowsFor(db, 'conexiones_redes', meta.id)).map((a) => a.accion)).toEqual(['crear', 'revocar']);
      const again = await createConexion(db, clienteId, { red: 'youtube', etiqueta: 'y2', secreto: 'other' }, actor);
      expect(await getSecretForUse(db, clienteId, again.id)).toBe('other');
      expect(await listConexiones(db, clienteId)).toHaveLength(2);
    });
  });

  it('rotate replaces the secret, sets rotada_en and handles expira_en', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, actor } = await setup(db);
      const expiraEn = new Date('2030-01-01T00:00:00Z');
      const meta = await createConexion(db, clienteId, { red: 'instagram', etiqueta: 'i', secreto: 'old-secret', expiraEn }, actor);
      const before = (await db.query('SELECT * FROM conexiones_redes WHERE id = $1', [meta.id])).rows[0];
      const kept = await rotateConexion(db, clienteId, meta.id, 'new-secret', actor);
      expect(kept.rotada_en).not.toBeNull();
      expect(kept.expira_en).toEqual(expiraEn);
      const after = (await db.query('SELECT * FROM conexiones_redes WHERE id = $1', [meta.id])).rows[0];
      expect(after.secreto_cifrado.equals(before.secreto_cifrado)).toBe(false);
      expect(await getSecretForUse(db, clienteId, meta.id)).toBe('new-secret');
      const newExpiry = new Date('2031-01-01T00:00:00Z');
      expect((await rotateConexion(db, clienteId, meta.id, 'newer', actor, { expiraEn: newExpiry })).expira_en).toEqual(newExpiry);
      expect((await rotateConexion(db, clienteId, meta.id, 'newest', actor, { expiraEn: null })).expira_en).toBeNull();
    });
  });

  it('rotate and revoke accept the sistema actor and are audited', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, actor } = await setup(db);
      const meta = await createConexion(db, clienteId, { red: 'facebook', etiqueta: 'f', secreto: 'old' }, actor);
      await rotateConexion(db, clienteId, meta.id, 'refreshed', SISTEMA);
      await revokeConexion(db, clienteId, meta.id, SISTEMA);
      const audit = await auditRowsFor(db, 'conexiones_redes', meta.id);
      expect(audit.map((a) => [a.accion, a.actor_tipo])).toEqual([
        ['crear', 'usuario'],
        ['rotar_secreto', 'sistema'],
        ['revocar', 'sistema'],
      ]);
    });
  });

  it('getSecretForUse writes exactly one usar_secreto audit row with metadata only', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, actor } = await setup(db);
      const meta = await createConexion(db, clienteId, { red: 'instagram', etiqueta: '@uso', secreto: SECRET }, actor);
      const uses = async () => (await auditRowsFor(db, 'conexiones_redes', meta.id)).filter((a) => a.accion === 'usar_secreto');
      expect(await uses()).toHaveLength(0);
      await getSecretForUse(db, clienteId, meta.id);
      const rows = await uses();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_tipo: 'sistema', cliente_id: clienteId, datos_antes: null });
      expect(rows[0]!.datos_despues).toMatchObject({ id: meta.id, red: 'instagram', etiqueta: '@uso', secreto_version_clave: 1 });
      const secretKeys = Object.keys(rows[0]!.datos_despues!).filter((k) => k.startsWith('secreto') && k !== 'secreto_version_clave');
      expect(secretKeys).toEqual([]);
      expect(JSON.stringify(rows[0])).not.toContain('fake-access-token');
    });
  });

  it('a failed use (foreign client) writes no audit row', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, actor } = await setup(db);
      const other = await setup(db);
      const meta = await createConexion(db, clienteId, { red: 'instagram', etiqueta: 'x', secreto: SECRET }, actor);
      await expect(getSecretForUse(db, other.clienteId, meta.id)).rejects.toThrow(ConexionNotFoundError);
      expect((await auditRowsFor(db, 'conexiones_redes', meta.id)).map((a) => a.accion)).toEqual(['crear']);
    });
  });

  it('no audit row contains secret material', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, actor } = await setup(db);
      const meta = await createConexion(db, clienteId, { red: 'instagram', etiqueta: '@aud', secreto: SECRET }, actor);
      await getSecretForUse(db, clienteId, meta.id);
      const afterCreate = (await db.query('SELECT * FROM conexiones_redes WHERE id = $1', [meta.id])).rows[0];
      await rotateConexion(db, clienteId, meta.id, 'rotated-secret-value', actor);
      const afterRotate = (await db.query('SELECT * FROM conexiones_redes WHERE id = $1', [meta.id])).rows[0];
      await revokeConexion(db, clienteId, meta.id, actor);
      const audit = await auditRowsFor(db, 'conexiones_redes', meta.id);
      expect(audit.map((a) => a.accion)).toEqual(['crear', 'usar_secreto', 'rotar_secreto', 'revocar']);
      const dump = JSON.stringify(audit);
      for (const needle of [
        ...secretNeedles(afterCreate, ['fake-access-token', 'fake-refresh-token']),
        ...secretNeedles(afterRotate, ['rotated-secret-value']),
      ]) {
        expect(dump).not.toContain(needle);
      }
      expect(audit[0]!.datos_despues).toMatchObject({ secreto_cambiado: true });
      expect(audit[2]!.datos_despues).toMatchObject({ secreto_cambiado: true });
    });
  });
});
