import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { cleanupDomainTables } from '../../tests/utils/cleanup.js';
import { getTestPool } from '../../tests/utils/testPool.js';
import { PERFIL_BLOCKS, createCliente, createPerfilMarca, createUsuario } from '../../tests/utils/factories/index.js';

describe('perfil_marca versioning', () => {
  it('rejects a second current version for the same client', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await createPerfilMarca(db, { clienteId: cliente.id });
      await expect(createPerfilMarca(db, { clienteId: cliente.id })).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('allows a current version per client', async () => {
    await withTestTransaction(async (db) => {
      await createPerfilMarca(db);
      await expect(createPerfilMarca(db)).resolves.toMatchObject({ version: 1, es_actual: true });
    });
  });

  it('keeps old versions stored next to the current one', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await createPerfilMarca(db, { clienteId: cliente.id, esActual: false });
      const current = await createPerfilMarca(db, { clienteId: cliente.id });
      expect(current.version).toBe(2);
      const { rows } = await db.query(
        'SELECT version, es_actual FROM perfil_marca WHERE cliente_id = $1 ORDER BY version',
        [cliente.id],
      );
      expect(rows).toEqual([
        { version: 1, es_actual: false },
        { version: 2, es_actual: true },
      ]);
    });
  });

  it('rejects a duplicate (cliente_id, version)', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await createPerfilMarca(db, { clienteId: cliente.id, version: 1, esActual: false });
      await expect(
        createPerfilMarca(db, { clienteId: cliente.id, version: 1, esActual: false }),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });
});

describe('perfil_marca columns', () => {
  it('defaults every block to an empty object and idioma_contenido to NULL', async () => {
    await withTestTransaction(async (db) => {
      const row = await createPerfilMarca(db);
      for (const block of PERFIL_BLOCKS) expect(row[block]).toEqual({});
      expect(row.idioma_contenido).toBeNull();
    });
  });

  it('accepts es, en and ambos and rejects anything else', async () => {
    for (const idioma of ['es', 'en', 'ambos']) {
      await withTestTransaction(async (db) => {
        await expect(createPerfilMarca(db, { idiomaContenido: idioma })).resolves.toMatchObject({
          idioma_contenido: idioma,
        });
      });
    }
    await withTestTransaction(async (db) => {
      await expect(createPerfilMarca(db, { idiomaContenido: 'fr' })).rejects.toMatchObject({ code: '23514' });
    });
  });

  it.each(PERFIL_BLOCKS)('rejects a non-object value in %s', async (block) => {
    for (const bad of [[], 'texto', 5, null]) {
      await withTestTransaction(async (db) => {
        await expect(createPerfilMarca(db, { [block]: bad })).rejects.toMatchObject({ code: '23514' });
      });
    }
  });

  it('requires creado_por and a real cliente_id and usuario', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await expect(
        db.query(`INSERT INTO perfil_marca (cliente_id, version, es_actual) VALUES ($1, 1, true)`, [cliente.id]),
      ).rejects.toMatchObject({ code: '23502' });
    });
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db);
      await expect(
        createPerfilMarca(db, { clienteId: '00000000-0000-0000-0000-000000000000', creadoPor: usuario.id }),
      ).rejects.toMatchObject({ code: '23503' });
    });
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await expect(
        createPerfilMarca(db, { clienteId: cliente.id, creadoPor: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });
});

describe('perfil_marca immutability', () => {
  it('rejects updating a block', async () => {
    await withTestTransaction(async (db) => {
      const row = await createPerfilMarca(db);
      await expect(
        db.query(`UPDATE perfil_marca SET identidad = '{"nombre":"x"}' WHERE id = $1`, [row.id]),
      ).rejects.toThrow(/immutable/);
    });
  });

  it('rejects updating a block together with es_actual true -> false', async () => {
    await withTestTransaction(async (db) => {
      const row = await createPerfilMarca(db);
      await expect(
        db.query(`UPDATE perfil_marca SET es_actual = false, idioma_contenido = 'es' WHERE id = $1`, [row.id]),
      ).rejects.toThrow(/immutable/);
    });
  });

  it('allows es_actual true -> false', async () => {
    await withTestTransaction(async (db) => {
      const row = await createPerfilMarca(db);
      const res = await db.query(`UPDATE perfil_marca SET es_actual = false WHERE id = $1`, [row.id]);
      expect(res.rowCount).toBe(1);
    });
  });

  it('rejects es_actual false -> true', async () => {
    await withTestTransaction(async (db) => {
      const row = await createPerfilMarca(db, { esActual: false });
      await expect(db.query(`UPDATE perfil_marca SET es_actual = true WHERE id = $1`, [row.id])).rejects.toThrow(
        /immutable/,
      );
    });
  });

  it('rejects DELETE', async () => {
    await withTestTransaction(async (db) => {
      const row = await createPerfilMarca(db);
      await expect(db.query(`DELETE FROM perfil_marca WHERE id = $1`, [row.id])).rejects.toThrow(/cannot be deleted/);
    });
  });

  it('is still emptied by cleanupDomainTables (TRUNCATE is not blocked)', async () => {
    const pool = getTestPool();
    await createPerfilMarca(pool);
    await cleanupDomainTables(pool);
    const { rows } = await pool.query('SELECT count(*) AS n FROM perfil_marca');
    expect(Number(rows[0].n)).toBe(0);
  });
});
