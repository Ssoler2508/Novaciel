import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { createCliente, createReglaProhibida } from '../../../tests/utils/factories/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { createRegla, deleteRegla, listReglas, updateRegla } from './reglasRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('reglasRepository', () => {
  it('creates and lists rules of a client, with one audit row on create', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const regla = await createRegla(db, clienteId, { tipo: 'palabra', texto: 'garantizado', motivo: 'Publicidad veraz' }, SISTEMA);
      expect((await listReglas(db, clienteId)).map((r) => r.id)).toEqual([regla.id]);
      const audit = await auditRowsFor(db, 'reglas_prohibidas', regla.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ accion: 'crear', cliente_id: clienteId, datos_antes: null });
    });
  });

  it('updates and deletes with one audit row each', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const regla = await createReglaProhibida(db, { clienteId, texto: 'gratis' });
      const updated = await updateRegla(db, clienteId, regla.id, { motivo: 'Promesa vetada', tipo: 'promesa' }, SISTEMA);
      expect(updated).toMatchObject({ motivo: 'Promesa vetada', tipo: 'promesa' });
      expect(await deleteRegla(db, clienteId, regla.id, SISTEMA)).toBe(true);
      const audit = await auditRowsFor(db, 'reglas_prohibidas', regla.id);
      expect(audit.map((a) => a.accion)).toEqual(['actualizar', 'eliminar']);
      expect(audit[0]).toMatchObject({ datos_antes: { tipo: 'palabra' }, datos_despues: { tipo: 'promesa' } });
      expect(await listReglas(db, clienteId)).toEqual([]);
    });
  });

  it('can clear the motivo with an explicit NULL', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const regla = await createReglaProhibida(db, { clienteId, motivo: 'algo' });
      expect((await updateRegla(db, clienteId, regla.id, { motivo: null }, SISTEMA))?.motivo).toBeNull();
    });
  });

  it('writes no audit row when nothing matches', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      expect(await updateRegla(db, clienteId, UNKNOWN, { texto: 'x' }, SISTEMA)).toBeNull();
      expect(await deleteRegla(db, clienteId, UNKNOWN, SISTEMA)).toBe(false);
      expect(await auditRowsFor(db, 'reglas_prohibidas', UNKNOWN)).toHaveLength(0);
    });
  });

  it('keeps clients separate', async () => {
    await withTestTransaction(async (db) => {
      const a = asClienteId((await createCliente(db)).id);
      const b = asClienteId((await createCliente(db)).id);
      await createReglaProhibida(db, { clienteId: b.valueOf() });
      expect(await listReglas(db, a)).toEqual([]);
    });
  });
});
