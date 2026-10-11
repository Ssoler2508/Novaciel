import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { createCliente, createHechoVerificado, createUsuario } from '../../../tests/utils/factories/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { createHecho, deleteHecho, getHecho, getValidHechos, listHechos, updateHecho } from './hechosRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

async function setup(db: Parameters<typeof createCliente>[0]) {
  const clienteId = asClienteId((await createCliente(db)).id);
  const verificadoPor = (await createUsuario(db)).id;
  return { clienteId, verificadoPor };
}

describe('hechosRepository basic operations', () => {
  it('creates, reads and lists facts of a client, with one audit row on create', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, verificadoPor } = await setup(db);
      const hecho = await createHecho(db, clienteId, { tipo: 'precio', enunciado: 'Café $5.000', fuente: 'Carta', verificadoPor }, SISTEMA);
      expect(await getHecho(db, clienteId, hecho.id)).toMatchObject({ enunciado: 'Café $5.000' });
      expect((await listHechos(db, clienteId)).map((h) => h.id)).toEqual([hecho.id]);
      const audit = await auditRowsFor(db, 'hechos_verificados', hecho.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ accion: 'crear', cliente_id: clienteId, actor_tipo: 'sistema', datos_antes: null });
    });
  });

  it('updates with one audit row holding before and after', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, verificadoPor } = await setup(db);
      const hecho = await createHecho(db, clienteId, { tipo: 'horario', enunciado: 'Abrimos 8am', fuente: 'Dueño', verificadoPor }, SISTEMA);
      const updated = await updateHecho(db, clienteId, hecho.id, { enunciado: 'Abrimos 7am' }, SISTEMA);
      expect(updated?.enunciado).toBe('Abrimos 7am');
      const audit = await auditRowsFor(db, 'hechos_verificados', hecho.id);
      expect(audit.map((a) => a.accion)).toEqual(['crear', 'actualizar']);
      expect(audit[1]).toMatchObject({
        datos_antes: { enunciado: 'Abrimos 8am' },
        datos_despues: { enunciado: 'Abrimos 7am' },
      });
    });
  });

  it('deletes with one audit row holding the before image', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await setup(db);
      const hecho = await createHechoVerificado(db, { clienteId });
      expect(await deleteHecho(db, clienteId, hecho.id, SISTEMA)).toBe(true);
      expect(await getHecho(db, clienteId, hecho.id)).toBeNull();
      const audit = await auditRowsFor(db, 'hechos_verificados', hecho.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ accion: 'eliminar', datos_despues: null, datos_antes: { id: hecho.id } });
    });
  });

  it('writes no audit row when nothing matches or the patch is empty', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await setup(db);
      const hecho = await createHechoVerificado(db, { clienteId });
      expect(await updateHecho(db, clienteId, UNKNOWN, { enunciado: 'x' }, SISTEMA)).toBeNull();
      expect(await updateHecho(db, clienteId, hecho.id, {}, SISTEMA)).toBeNull();
      expect(await deleteHecho(db, clienteId, UNKNOWN, SISTEMA)).toBe(false);
      expect(await auditRowsFor(db, 'hechos_verificados', UNKNOWN)).toHaveLength(0);
      expect(await auditRowsFor(db, 'hechos_verificados', hecho.id)).toHaveLength(0);
    });
  });

  it('refuses to change id or cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await setup(db);
      const hecho = await createHechoVerificado(db, { clienteId });
      await expect(
        updateHecho(db, clienteId, hecho.id, { cliente_id: UNKNOWN } as never, SISTEMA),
      ).rejects.toThrow(/cliente_id/);
    });
  });

  it('rolls back the write when the database rejects it, with no audit row', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, verificadoPor } = await setup(db);
      await expect(
        createHecho(db, clienteId, { tipo: 'promocion', enunciado: '2x1', fuente: 'Dueño', verificadoPor }, SISTEMA),
      ).rejects.toMatchObject({ code: '23514' });
      const { rows } = await db.query(`SELECT count(*) AS n FROM auditoria WHERE cliente_id = $1`, [clienteId]);
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});

describe('getValidHechos', () => {
  it('excludes expired and not-yet-valid facts and keeps open-ended and current ones', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await setup(db);
      const open = await createHechoVerificado(db, { clienteId });
      const promo = await createHechoVerificado(db, {
        clienteId,
        tipo: 'promocion',
        vigenteHasta: new Date(Date.now() + 5 * DAY_MS),
      });
      await createHechoVerificado(db, { clienteId, expired: true });
      await createHechoVerificado(db, {
        clienteId,
        vigenteDesde: new Date(Date.now() + 2 * DAY_MS),
        vigenteHasta: new Date(Date.now() + 9 * DAY_MS),
      });
      expect((await getValidHechos(db, clienteId)).map((h) => h.id).sort()).toEqual([open.id, promo.id].sort());
    });
  });

  it('respects `at` with a half-open interval', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await setup(db);
      const desde = new Date('2026-01-01T00:00:00Z');
      const hasta = new Date('2026-02-01T00:00:00Z');
      const hecho = await createHechoVerificado(db, { clienteId, tipo: 'promocion', vigenteDesde: desde, vigenteHasta: hasta });
      const ids = async (at: Date) => (await getValidHechos(db, clienteId, at)).map((h) => h.id);
      expect(await ids(new Date('2025-12-31T23:59:59Z'))).toEqual([]);
      expect(await ids(desde)).toEqual([hecho.id]);
      expect(await ids(new Date('2026-01-15T00:00:00Z'))).toEqual([hecho.id]);
      expect(await ids(hasta)).toEqual([]);
    });
  });

  it('never returns another client\'s facts', async () => {
    await withTestTransaction(async (db) => {
      const a = await setup(db);
      const b = await setup(db);
      const hechoB = await createHechoVerificado(db, { clienteId: b.clienteId });
      expect(await getValidHechos(db, a.clienteId)).toEqual([]);
      expect(await getHecho(db, a.clienteId, hechoB.id)).toBeNull();
      expect(await listHechos(db, a.clienteId)).toEqual([]);
    });
  });
});
