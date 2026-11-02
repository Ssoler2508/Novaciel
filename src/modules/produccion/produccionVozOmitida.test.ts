import { describe, expect, it } from 'vitest';
import { createCliente, createProduccion } from '../../../tests/utils/factories/index.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { recordAudit } from '../auditoria/recordAudit.js';
import { resolverVozOmitida, vozOmitidaDeProduccion } from '../locuciones/locucionesRepository.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { getProduccionActual } from './produccionRepository.js';
import { VOZ_OMITIDA_MOTIVOS } from './vozReel.js';

// Debt cleanup 01, checkpoint B: producciones.voz_omitida_motivo. The column itself (closed list, immutable, NULL by
// default), how quality control resolves the reason (column first, audit row for older productions) and isolation.
// The service writes the column for each reason in produccionReel.render.test.ts and produccionReelVoz.render.test.ts.

const SISTEMA = { tipo: 'sistema' } as const;

async function auditCrear(db: Db, clienteId: ClienteId, produccionId: string, voz_omitida: string) {
  await recordAudit(db, { actor: SISTEMA, accion: 'crear', tabla: 'producciones', filaId: produccionId, clienteId, despues: { voz_omitida } });
}

describe('producciones.voz_omitida_motivo', () => {
  it('is NULL by default (a voice used, or no voice to omit)', async () => {
    await withTestTransaction(async (db) => {
      const p = await createProduccion(db);
      expect(p.voz_omitida_motivo).toBeNull();
      expect((await getProduccionActual(db, p.cliente_id as ClienteId, p.pieza_id))!.voz_omitida_motivo).toBeNull();
    });
  });

  it.each(VOZ_OMITIDA_MOTIVOS)('stores the code "%s" and the view returns it', async (motivo) => {
    await withTestTransaction(async (db) => {
      const p = await createProduccion(db, { vozOmitidaMotivo: motivo });
      expect(p.voz_omitida_motivo).toBe(motivo);
      expect((await getProduccionActual(db, p.cliente_id as ClienteId, p.pieza_id))!.voz_omitida_motivo).toBe(motivo);
    });
  });

  it('accepts only the closed list of codes', async () => {
    await withTestTransaction(async (db) => {
      await db.query('SAVEPOINT s');
      await expect(createProduccion(db, { vozOmitidaMotivo: 'otro_motivo' })).rejects.toThrow(/producciones_voz_omitida_motivo_check/);
      await db.query('ROLLBACK TO SAVEPOINT s');
      await db.query('SAVEPOINT t');
      await expect(createProduccion(db, { vozOmitidaMotivo: '' })).rejects.toThrow(/producciones_voz_omitida_motivo_check/);
      await db.query('ROLLBACK TO SAVEPOINT t');
    });
  });

  it('is immutable: it cannot be set, changed or cleared after the insert', async () => {
    await withTestTransaction(async (db) => {
      const sin = await createProduccion(db);
      const con = await createProduccion(db, { vozOmitidaMotivo: 'sin_plantilla' });
      for (const [id, valor] of [[sin.id, 'sin_texto'], [con.id, 'sin_proveedor'], [con.id, null]] as const) {
        await db.query('SAVEPOINT s');
        await expect(db.query('UPDATE producciones SET voz_omitida_motivo = $2 WHERE id = $1', [id, valor])).rejects.toThrow(/never edited/);
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
      // Retiring a production (the only allowed change) leaves the column alone.
      const retired = (await db.query('UPDATE producciones SET es_actual = false WHERE id = $1 RETURNING voz_omitida_motivo', [con.id])).rows[0];
      expect(retired.voz_omitida_motivo).toBe('sin_plantilla');
    });
  });
});

describe('resolverVozOmitida: the column first, the audit row for older productions', () => {
  it('uses the column when it is set, even if the audit row says something else', async () => {
    await withTestTransaction(async (db) => {
      const p = await createProduccion(db, { vozOmitidaMotivo: 'sin_plantilla' });
      await auditCrear(db, p.cliente_id as ClienteId, p.id, 'sin_texto');
      expect(await resolverVozOmitida(db, p.cliente_id as ClienteId, p)).toEqual({ motivo: 'sin_plantilla', origen: 'columna' });
    });
  });

  it('falls back to the audit row when the column is NULL (a production made before the column)', async () => {
    await withTestTransaction(async (db) => {
      const p = await createProduccion(db);
      await auditCrear(db, p.cliente_id as ClienteId, p.id, 'sin_plantilla');
      expect(await resolverVozOmitida(db, p.cliente_id as ClienteId, p)).toEqual({ motivo: 'sin_plantilla', origen: 'auditoria' });
    });
  });

  it('answers null when the column is NULL and the audit has no omission', async () => {
    await withTestTransaction(async (db) => {
      const p = await createProduccion(db);
      await recordAudit(db, { actor: SISTEMA, accion: 'crear', tabla: 'producciones', filaId: p.id, clienteId: p.cliente_id as ClienteId, despues: { voces: 2 } });
      expect(await resolverVozOmitida(db, p.cliente_id as ClienteId, p)).toEqual({ motivo: null, origen: null });
    });
  });

  it('isolation: another client never reads the audit fallback of this production', async () => {
    await withTestTransaction(async (db) => {
      const p = await createProduccion(db);
      await auditCrear(db, p.cliente_id as ClienteId, p.id, 'sin_plantilla');
      const other = asClienteId((await createCliente(db)).id);
      expect(await vozOmitidaDeProduccion(db, other, p.id)).toBeNull();
      expect(await resolverVozOmitida(db, other, p)).toEqual({ motivo: null, origen: null });
      // And the other client cannot read the production (hence its column) at all.
      expect(await getProduccionActual(db, other, p.pieza_id)).toBeNull();
    });
  });
});
