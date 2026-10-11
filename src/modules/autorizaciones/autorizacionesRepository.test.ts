import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { createAutorizacionImagen, createCliente } from '../../../tests/utils/factories/index.js';
import { asClienteId } from '../shared/clienteId.js';
import * as repo from './autorizacionesRepository.js';
import {
  createAutorizacion,
  getAutorizacion,
  getValidAutorizaciones,
  listAutorizaciones,
  revokeAutorizacion,
  updateAutorizacion,
} from './autorizacionesRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

const newAutorizacion = (overrides: Partial<repo.NewAutorizacion> = {}): repo.NewAutorizacion => ({
  personaNombre: 'Persona Ficticia',
  alcance: 'Redes sociales',
  vigenteHasta: new Date(Date.now() + 365 * DAY_MS),
  documentoClave: 'autorizaciones/ficticia.pdf',
  esMenor: false,
  ...overrides,
});

describe('autorizacionesRepository', () => {
  it('exports no delete function: consent is only revoked', () => {
    expect(Object.keys(repo).filter((name) => /delete|remove|destroy/i.test(name))).toEqual([]);
  });

  it('creates and reads an authorization, with one audit row on create', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const row = await createAutorizacion(db, clienteId, newAutorizacion(), SISTEMA);
      expect(row.es_menor).toBe(false);
      expect(await getAutorizacion(db, clienteId, row.id)).toMatchObject({ persona_nombre: 'Persona Ficticia' });
      expect((await listAutorizaciones(db, clienteId)).map((a) => a.id)).toEqual([row.id]);
      const audit = await auditRowsFor(db, 'autorizaciones_imagen', row.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ accion: 'crear', cliente_id: clienteId, datos_antes: null });
    });
  });

  it('requires esMenor (checked by npm run typecheck)', () => {
    const typeChecks = async (db: Parameters<typeof createAutorizacion>[0], id: ReturnType<typeof asClienteId>) => {
      const { esMenor: _omitted, ...withoutEsMenor } = newAutorizacion();
      // @ts-expect-error esMenor has no default
      await createAutorizacion(db, id, withoutEsMenor, SISTEMA);
    };
    expect(typeof typeChecks).toBe('function');
  });

  it('updates only alcance and validity, with one audit row', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const row = await createAutorizacionImagen(db, { clienteId });
      const nuevaFecha = new Date(Date.now() + 30 * DAY_MS);
      const updated = await updateAutorizacion(db, clienteId, row.id, { alcance: 'Solo Instagram', vigente_hasta: nuevaFecha }, SISTEMA);
      expect(updated).toMatchObject({ alcance: 'Solo Instagram' });
      const audit = await auditRowsFor(db, 'autorizaciones_imagen', row.id);
      expect(audit.map((a) => a.accion)).toEqual(['actualizar']);
      expect(audit[0]).toMatchObject({ datos_despues: { alcance: 'Solo Instagram' } });
    });
  });

  it.each(['es_menor', 'persona_nombre', 'documento_clave', 'revocada_en'])('rejects a patch that changes %s', async (column) => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const row = await createAutorizacionImagen(db, { clienteId, esMenor: true });
      await expect(
        updateAutorizacion(db, clienteId, row.id, { [column]: column === 'es_menor' ? false : 'x' } as never, SISTEMA),
      ).rejects.toThrow(new RegExp(`"${column}"`));
      expect((await getAutorizacion(db, clienteId, row.id))?.es_menor).toBe(true);
      expect(await auditRowsFor(db, 'autorizaciones_imagen', row.id)).toHaveLength(0);
    });
  });

  it('revokes once, with one audit row, and no second revocation', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const row = await createAutorizacionImagen(db, { clienteId });
      const at = new Date(Date.now() + 1000);
      const revoked = await revokeAutorizacion(db, clienteId, row.id, SISTEMA, at);
      expect(revoked?.revocada_en).toEqual(at);
      expect(await revokeAutorizacion(db, clienteId, row.id, SISTEMA)).toBeNull();
      const audit = await auditRowsFor(db, 'autorizaciones_imagen', row.id);
      expect(audit.map((a) => a.accion)).toEqual(['revocar']);
      expect(audit[0]).toMatchObject({ datos_antes: { revocada_en: null } });
    });
  });

  it('writes no audit row when nothing matches', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      expect(await updateAutorizacion(db, clienteId, UNKNOWN, { alcance: 'x' }, SISTEMA)).toBeNull();
      expect(await revokeAutorizacion(db, clienteId, UNKNOWN, SISTEMA)).toBeNull();
      expect(await auditRowsFor(db, 'autorizaciones_imagen', UNKNOWN)).toHaveLength(0);
    });
  });
});

describe('getValidAutorizaciones', () => {
  it('returns only valid, non-minor, non-revoked authorizations', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const valid = await createAutorizacionImagen(db, { clienteId });
      await createAutorizacionImagen(db, { clienteId, expired: true });
      await createAutorizacionImagen(db, { clienteId, revoked: true });
      await createAutorizacionImagen(db, { clienteId, esMenor: true });
      await createAutorizacionImagen(db, {
        clienteId,
        vigenteDesde: new Date(Date.now() + DAY_MS),
        vigenteHasta: new Date(Date.now() + 9 * DAY_MS),
      });
      expect((await getValidAutorizaciones(db, clienteId)).map((a) => a.id)).toEqual([valid.id]);
      expect(await listAutorizaciones(db, clienteId)).toHaveLength(5);
    });
  });

  it('never returns a minor, whatever the date', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      await createAutorizacionImagen(db, { clienteId, esMenor: true });
      expect(await getValidAutorizaciones(db, clienteId)).toEqual([]);
      expect(await getValidAutorizaciones(db, clienteId, new Date(Date.now() + 30 * DAY_MS))).toEqual([]);
    });
  });

  it('respects `at` for validity and revocation (half-open)', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const desde = new Date('2026-01-01T00:00:00Z');
      const hasta = new Date('2026-12-31T00:00:00Z');
      const revocada = new Date('2026-06-01T00:00:00Z');
      const row = await createAutorizacionImagen(db, { clienteId, vigenteDesde: desde, vigenteHasta: hasta, revocadaEn: revocada });
      const ids = async (at: Date) => (await getValidAutorizaciones(db, clienteId, at)).map((a) => a.id);
      expect(await ids(new Date('2025-12-31T00:00:00Z'))).toEqual([]);
      expect(await ids(desde)).toEqual([row.id]);
      expect(await ids(new Date('2026-05-31T23:59:59Z'))).toEqual([row.id]);
      expect(await ids(revocada)).toEqual([]);
      expect(await ids(new Date('2026-09-01T00:00:00Z'))).toEqual([]);
    });
  });

  it('has no parameter to include minors', () => {
    expect(getValidAutorizaciones.length).toBeLessThanOrEqual(3);
  });

  it('never returns another client\'s authorizations', async () => {
    await withTestTransaction(async (db) => {
      const a = asClienteId((await createCliente(db)).id);
      const b = asClienteId((await createCliente(db)).id);
      const rowB = await createAutorizacionImagen(db, { clienteId: b });
      expect(await getValidAutorizaciones(db, a)).toEqual([]);
      expect(await getAutorizacion(db, a, rowB.id)).toBeNull();
      expect(await revokeAutorizacion(db, a, rowB.id, SISTEMA)).toBeNull();
    });
  });
});
