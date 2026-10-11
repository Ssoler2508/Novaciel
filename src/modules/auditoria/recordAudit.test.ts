import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { DOMAIN_TABLES } from '../../../tests/utils/cleanup.js';
import { getTestPool } from '../../../tests/utils/testPool.js';
import { createCliente, createUsuario } from '../../../tests/utils/factories/index.js';
import { recordAudit, type AuditEntry } from './recordAudit.js';
import { asClienteId } from '../shared/clienteId.js';

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';
const base: AuditEntry = { actor: { tipo: 'sistema' }, accion: 'insert', tabla: 'clientes', filaId: 'x' };

const countAuditoria = async () =>
  Number((await getTestPool().query('SELECT count(*) AS n FROM auditoria')).rows[0].n);

describe('recordAudit', () => {
  it('writes a row for a user actor with client and before/after data', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const usuario = await createUsuario(db);
      await recordAudit(db, {
        actor: { tipo: 'usuario', usuarioId: usuario.id },
        accion: 'update',
        tabla: 'clientes',
        filaId: cliente.id,
        clienteId: asClienteId(cliente.id),
        antes: { estado: 'en_onboarding' },
        despues: { estado: 'activo' },
      });
      const { rows } = await db.query('SELECT * FROM auditoria WHERE fila_id = $1', [cliente.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_tipo: 'usuario',
        actor_usuario_id: usuario.id,
        accion: 'update',
        tabla: 'clientes',
        cliente_id: cliente.id,
        datos_antes: { estado: 'en_onboarding' },
        datos_despues: { estado: 'activo' },
      });
    });
  });

  it('writes a system row without cliente_id', async () => {
    await withTestTransaction(async (db) => {
      await recordAudit(db, { ...base, filaId: 'global-1' });
      const { rows } = await db.query('SELECT * FROM auditoria WHERE fila_id = $1', ['global-1']);
      expect(rows[0]).toMatchObject({
        actor_tipo: 'sistema',
        actor_usuario_id: null,
        cliente_id: null,
        datos_antes: null,
        datos_despues: null,
      });
    });
  });

  it('accepts an unknown cliente_id and user id (no foreign keys)', async () => {
    await withTestTransaction(async (db) => {
      await expect(
        recordAudit(db, {
          ...base,
          actor: { tipo: 'usuario', usuarioId: UNKNOWN_ID },
          clienteId: asClienteId(UNKNOWN_ID),
        }),
      ).resolves.toBeUndefined();
    });
  });

  it('runs in the caller transaction: rows vanish on rollback', async () => {
    const before = await countAuditoria();
    await withTestTransaction(async (db) => {
      await recordAudit(db, base);
      await recordAudit(db, base);
      expect(Number((await db.query('SELECT count(*) AS n FROM auditoria')).rows[0].n)).toBe(before + 2);
    });
    expect(await countAuditoria()).toBe(before);
  });
});

describe('auditoria constraints', () => {
  const invalid: [string, Partial<AuditEntry> | Record<string, unknown>][] = [
    ['accion with uppercase', { accion: 'Insert' }],
    ['accion with spaces', { accion: 'asignar rol' }],
    ['accion starting with underscore', { accion: '_insert' }],
    ['blank accion', { accion: '' }],
    ['blank tabla', { tabla: ' ' }],
    ['blank fila_id', { filaId: '' }],
    ['array antes', { antes: [] as never }],
    ['array despues', { despues: [] as never }],
  ];
  it.each(invalid)('rejects %s', async (_name, patch) => {
    await withTestTransaction(async (db) => {
      await expect(recordAudit(db, { ...base, ...patch } as AuditEntry)).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects actor_tipo and actor_usuario_id that disagree', async () => {
    const insert = (tipo: string, usuarioId: string | null) => (db: { query: (s: string, p: unknown[]) => Promise<unknown> }) =>
      db.query(`INSERT INTO auditoria (actor_tipo, actor_usuario_id, accion, tabla, fila_id) VALUES ($1, $2, 'insert', 't', '1')`, [
        tipo,
        usuarioId,
      ]);
    await withTestTransaction(async (db) => {
      await expect(insert('usuario', null)(db)).rejects.toMatchObject({ code: '23514' });
    });
    await withTestTransaction(async (db) => {
      await expect(insert('sistema', UNKNOWN_ID)(db)).rejects.toMatchObject({ code: '23514' });
    });
    await withTestTransaction(async (db) => {
      await expect(insert('robot', null)(db)).rejects.toMatchObject({ code: '23514' });
    });
  });
});

describe('auditoria is append-only', () => {
  it('rejects UPDATE', async () => {
    await withTestTransaction(async (db) => {
      await recordAudit(db, { ...base, filaId: 'u1' });
      await expect(db.query(`UPDATE auditoria SET accion = 'delete' WHERE fila_id = 'u1'`)).rejects.toThrow(
        /append-only: UPDATE/,
      );
    });
  });

  it('rejects DELETE', async () => {
    await withTestTransaction(async (db) => {
      await recordAudit(db, { ...base, filaId: 'd1' });
      await expect(db.query(`DELETE FROM auditoria WHERE fila_id = 'd1'`)).rejects.toThrow(/append-only: DELETE/);
    });
  });

  it('rejects TRUNCATE, with and without CASCADE', async () => {
    await withTestTransaction(async (db) => {
      await expect(db.query('TRUNCATE auditoria')).rejects.toThrow(/append-only: TRUNCATE/);
    });
    await withTestTransaction(async (db) => {
      await expect(db.query('TRUNCATE auditoria CASCADE')).rejects.toThrow(/append-only: TRUNCATE/);
    });
  });
});

describe('auditoria isolation from cleanup', () => {
  it('is not in the cleanup list', () => {
    expect(DOMAIN_TABLES).not.toContain('auditoria');
  });

  it('has no foreign key in or out, so TRUNCATE ... CASCADE never reaches it', async () => {
    const { rows } = await getTestPool().query(
      `SELECT conname FROM pg_constraint
       WHERE contype = 'f' AND ('auditoria'::regclass IN (conrelid, confrelid))`,
    );
    expect(rows).toEqual([]);
  });
});
