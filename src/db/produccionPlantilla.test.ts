import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createGuion, createProduccion, moverPieza } from '../../tests/utils/factories/index.js';
import { PLANTILLAS } from '../modules/produccion/plantillas.js';
import type { Db } from './types.js';

// Migration 2000 (Step 7c): the template a production was made with.

async function expectFails(db: Db, match: string | RegExp, run: () => Promise<unknown>): Promise<void> {
  await db.query('SAVEPOINT expect_fails');
  await expect(run()).rejects.toThrow(match);
  await db.query('ROLLBACK TO SAVEPOINT expect_fails');
}

/** A piece of an approved plan with its brief, in guion_listo. `formato` decides reel or not. */
async function pieza(db: Db, formato: 'reel' | 'carrusel') {
  const guion = await createGuion(db, { formato });
  await moverPieza(db, guion.pieza_id, 'guion_listo');
  return { piezaId: guion.pieza_id, clienteId: guion.cliente_id, guionId: guion.id };
}

const REEL_ARCHIVO = [{ mime: 'video/mp4' }];

describe('producciones.plantilla and plantilla_version', () => {
  it('are null by default (images, and reels made with the PNG overlays)', async () => {
    await withTestTransaction(async (db) => {
      const carrusel = await pieza(db, 'carrusel');
      const p = await createProduccion(db, { piezaId: carrusel.piezaId });
      expect(p).toMatchObject({ plantilla: null, plantilla_version: null });
      const reel = await pieza(db, 'reel');
      expect(await createProduccion(db, { piezaId: reel.piezaId, archivos: REEL_ARCHIVO })).toMatchObject({ plantilla: null, plantilla_version: null });
    });
  });

  it('record the template of a reel, for every template of the registry', async () => {
    await withTestTransaction(async (db) => {
      for (const t of PLANTILLAS) {
        const reel = await pieza(db, 'reel');
        const p = await createProduccion(db, { piezaId: reel.piezaId, archivos: REEL_ARCHIVO, plantilla: t.id, plantillaVersion: t.version });
        expect(p).toMatchObject({ plantilla: t.id, plantilla_version: t.version });
      }
    });
  });

  it('are set together or not at all, with a valid id and a version of at least 1', async () => {
    await withTestTransaction(async (db) => {
      const reel = await pieza(db, 'reel');
      const make = (plantilla: string | null, plantillaVersion: number | null) =>
        createProduccion(db, { piezaId: reel.piezaId, archivos: REEL_ARCHIVO, plantilla, plantillaVersion });
      await expectFails(db, /producciones_plantilla_check/, () => make('barra_inferior', null));
      await expectFails(db, /producciones_plantilla_check/, () => make(null, 1));
      await expectFails(db, /producciones_plantilla_check/, () => make('barra_inferior', 0));
      await expectFails(db, /producciones_plantilla_check/, () => make('Barra Inferior', 1));
      await expectFails(db, /producciones_plantilla_check/, () => make('', 1));
      await expectFails(db, /producciones_plantilla_check/, () => make('x'.repeat(41), 1));
      await expectFails(db, /producciones_plantilla_check/, () => make("barra'; drop table producciones;--", 1));
      await expect(make('x'.repeat(40), 1)).resolves.toMatchObject({ plantilla_version: 1 });
    });
  });

  it('are refused for a piece that is not a reel', async () => {
    await withTestTransaction(async (db) => {
      const carrusel = await pieza(db, 'carrusel');
      await expectFails(db, /a text template is only for a reel/, () =>
        createProduccion(db, { piezaId: carrusel.piezaId, plantilla: 'barra_inferior', plantillaVersion: 1 }),
      );
    });
  });

  it('are never edited afterwards, like the rest of the production', async () => {
    await withTestTransaction(async (db) => {
      const reel = await pieza(db, 'reel');
      const p = await createProduccion(db, { piezaId: reel.piezaId, archivos: REEL_ARCHIVO, plantilla: 'palabra_a_palabra', plantillaVersion: 1 });
      await expectFails(db, /never edited/, () => db.query("UPDATE producciones SET plantilla = 'barra_inferior' WHERE id = $1", [p.id]));
      await expectFails(db, /never edited/, () => db.query('UPDATE producciones SET plantilla_version = 2 WHERE id = $1', [p.id]));
      await expectFails(db, /never edited/, () => db.query('UPDATE producciones SET plantilla = NULL, plantilla_version = NULL WHERE id = $1', [p.id]));
      // The one allowed change (retiring a version) still works with a template recorded.
      await db.query('UPDATE producciones SET es_actual = false WHERE id = $1', [p.id]);
      expect((await db.query('SELECT plantilla, plantilla_version FROM producciones WHERE id = $1', [p.id])).rows[0]).toEqual({ plantilla: 'palabra_a_palabra', plantilla_version: 1 });
    });
  });

  it('the template does not enter the np1 hash: it is metadata (the hash column is independent)', async () => {
    await withTestTransaction(async (db) => {
      const reel = await pieza(db, 'reel');
      const hashPieza = randomBytes(32);
      const p = await createProduccion(db, { piezaId: reel.piezaId, archivos: REEL_ARCHIVO, plantilla: 'barra_inferior', plantillaVersion: 1, hashPieza });
      expect(p.hash_pieza.equals(hashPieza)).toBe(true);
    });
  });
});
