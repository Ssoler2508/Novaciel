import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createGuion, createPerfilMarca, createProduccion, moverPieza } from '../../tests/utils/factories/index.js';
import type { Db } from './types.js';

// Step 8, checkpoint C: producciones.perfil_marca_id, the brand profile version a production was rendered with.

async function expectFails(db: Db, match: string | RegExp, run: () => Promise<unknown>): Promise<void> {
  await db.query('SAVEPOINT expect_fails');
  await expect(run()).rejects.toThrow(match);
  await db.query('ROLLBACK TO SAVEPOINT expect_fails');
}

async function piezaLista(db: Db) {
  const guion = await createGuion(db);
  await moverPieza(db, guion.pieza_id, 'guion_listo');
  return guion;
}

/** Raw insert of a production, to choose the profile (or none). */
const insertar = (db: Db, g: { cliente_id: string; pieza_id: string; id: string }, perfilMarcaId: string | null) =>
  db.query(
    `INSERT INTO producciones (cliente_id, pieza_id, guion_id, version, es_actual, red, texto_publicacion, hashtags, textos_alternativos, hash_version, hash_pieza, perfil_marca_id)
     VALUES ($1, $2, $3, 1, true, 'instagram', 'Texto ficticio', ARRAY['#ficticio'], ARRAY['Alt ficticio'], 'np1', decode(repeat('ab', 32), 'hex'), $4) RETURNING id`,
    [g.cliente_id, g.pieza_id, g.id, perfilMarcaId],
  );

describe('producciones.perfil_marca_id', () => {
  it('is recorded by the factory (the profile of the brief) and can be chosen', async () => {
    await withTestTransaction(async (db) => {
      const guion = await piezaLista(db);
      const produccion = await createProduccion(db, { piezaId: guion.pieza_id });
      expect(produccion.perfil_marca_id).toBe(guion.perfil_marca_id);
      const otro = await createPerfilMarca(db, { clienteId: guion.cliente_id, esActual: false });
      const siguiente = await createProduccion(db, { piezaId: guion.pieza_id, perfilMarcaId: otro.id });
      expect(siguiente.perfil_marca_id).toBe(otro.id);
    });
  });

  it('is required in a new production: the database refuses one that does not say which profile version it used', async () => {
    await withTestTransaction(async (db) => {
      const guion = await piezaLista(db);
      await expectFails(db, /must say which brand profile version/, () => insertar(db, guion, null));
      await expect(insertar(db, guion, guion.perfil_marca_id)).resolves.toBeDefined();
    });
  });

  it("must be a profile version of the same client: another client's profile is refused by the composite foreign key", async () => {
    await withTestTransaction(async (db) => {
      const guion = await piezaLista(db);
      const ajeno = await createPerfilMarca(db, {});
      await expectFails(db, /violates foreign key|viola la llave foránea|llave foránea/i, () => insertar(db, guion, ajeno.id));
    });
  });

  it('is immutable like the rest of the row: it cannot be changed or cleared, but the production can still be retired', async () => {
    await withTestTransaction(async (db) => {
      const guion = await piezaLista(db);
      const produccion = await createProduccion(db, { piezaId: guion.pieza_id });
      const otro = await createPerfilMarca(db, { clienteId: guion.cliente_id, esActual: false });
      await expectFails(db, /never edited/, () => db.query('UPDATE producciones SET perfil_marca_id = $2 WHERE id = $1', [produccion.id, otro.id]));
      await expectFails(db, /never edited/, () => db.query('UPDATE producciones SET perfil_marca_id = NULL WHERE id = $1', [produccion.id]));
      await db.query('UPDATE producciones SET es_actual = false WHERE id = $1', [produccion.id]);
      expect((await db.query('SELECT perfil_marca_id FROM producciones WHERE id = $1', [produccion.id])).rows[0].perfil_marca_id).toBe(guion.perfil_marca_id);
    });
  });

  it('the profile row of a production cannot be deleted (restrict), so the version it used is always there', async () => {
    await withTestTransaction(async (db) => {
      const guion = await piezaLista(db);
      await createProduccion(db, { piezaId: guion.pieza_id });
      await db.query('SAVEPOINT borrar');
      await expect(db.query('DELETE FROM perfil_marca WHERE id = $1', [guion.perfil_marca_id])).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT borrar');
    });
  });
});
