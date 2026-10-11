import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  createAutorizacionImagen,
  createCliente,
  createHechoVerificado,
  createReglaProhibida,
  createUsuario,
} from '../../tests/utils/factories/index.js';

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

describe('hechos_verificados', () => {
  it('rejects an invalid tipo and accepts the five valid ones', async () => {
    await withTestTransaction(async (db) => {
      await expect(createHechoVerificado(db, { tipo: 'rumor' })).rejects.toMatchObject({ code: '23514' });
    });
    for (const tipo of ['precio', 'horario', 'cifra', 'otro']) {
      await withTestTransaction(async (db) => {
        await expect(createHechoVerificado(db, { tipo })).resolves.toMatchObject({ tipo, vigente_hasta: null });
      });
    }
    await withTestTransaction(async (db) => {
      await expect(
        createHechoVerificado(db, { tipo: 'promocion', vigenteHasta: new Date(NOW + DAY_MS) }),
      ).resolves.toMatchObject({ tipo: 'promocion' });
    });
  });

  it('rejects a promocion without vigente_hasta', async () => {
    await withTestTransaction(async (db) => {
      await expect(createHechoVerificado(db, { tipo: 'promocion' })).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects a blank enunciado or fuente', async () => {
    await withTestTransaction(async (db) => {
      await expect(createHechoVerificado(db, { enunciado: '   ' })).rejects.toMatchObject({ code: '23514' });
    });
    await withTestTransaction(async (db) => {
      await expect(createHechoVerificado(db, { fuente: '' })).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects vigente_hasta that is not later than vigente_desde', async () => {
    const desde = new Date(NOW - DAY_MS);
    await withTestTransaction(async (db) => {
      await expect(
        createHechoVerificado(db, { vigenteDesde: desde, vigenteHasta: desde }),
      ).rejects.toMatchObject({ code: '23514' });
    });
    await withTestTransaction(async (db) => {
      await expect(
        createHechoVerificado(db, { vigenteDesde: desde, vigenteHasta: new Date(NOW - 2 * DAY_MS) }),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects unknown cliente_id and verificado_por', async () => {
    await withTestTransaction(async (db) => {
      await expect(createHechoVerificado(db, { clienteId: UNKNOWN_ID })).rejects.toMatchObject({ code: '23503' });
    });
    await withTestTransaction(async (db) => {
      await expect(createHechoVerificado(db, { verificadoPor: UNKNOWN_ID })).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('expired option produces an already expired row', async () => {
    await withTestTransaction(async (db) => {
      const row = await createHechoVerificado(db, { expired: true });
      expect(row.vigente_hasta!.getTime()).toBeLessThan(Date.now());
      expect(row.vigente_desde.getTime()).toBeLessThan(row.vigente_hasta!.getTime());
    });
  });

  it('expired promocion is still a valid row (it has an end date)', async () => {
    await withTestTransaction(async (db) => {
      await expect(createHechoVerificado(db, { tipo: 'promocion', expired: true })).resolves.toBeDefined();
    });
  });
});

describe('reglas_prohibidas', () => {
  it('accepts the four kinds and rejects an invalid tipo', async () => {
    for (const tipo of ['promesa', 'tema', 'palabra', 'elemento_visual']) {
      await withTestTransaction(async (db) => {
        await expect(createReglaProhibida(db, { tipo })).resolves.toMatchObject({ tipo });
      });
    }
    await withTestTransaction(async (db) => {
      await expect(createReglaProhibida(db, { tipo: 'otro' })).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects a blank texto', async () => {
    await withTestTransaction(async (db) => {
      await expect(createReglaProhibida(db, { texto: '  ' })).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects a duplicate rule for the same client, ignoring case', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await createReglaProhibida(db, { clienteId: cliente.id, tipo: 'palabra', texto: 'Garantizado' });
      await expect(
        createReglaProhibida(db, { clienteId: cliente.id, tipo: 'palabra', texto: 'garantizado' }),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('accepts the same text with another tipo or in another client', async () => {
    await withTestTransaction(async (db) => {
      const a = await createCliente(db);
      const b = await createCliente(db);
      await createReglaProhibida(db, { clienteId: a.id, tipo: 'palabra', texto: 'gratis' });
      await expect(createReglaProhibida(db, { clienteId: a.id, tipo: 'tema', texto: 'gratis' })).resolves.toBeDefined();
      await expect(createReglaProhibida(db, { clienteId: b.id, tipo: 'palabra', texto: 'gratis' })).resolves.toBeDefined();
    });
  });

  it('rejects an unknown cliente_id', async () => {
    await withTestTransaction(async (db) => {
      await expect(createReglaProhibida(db, { clienteId: UNKNOWN_ID })).rejects.toMatchObject({ code: '23503' });
    });
  });
});

describe('autorizaciones_imagen', () => {
  it('requires es_menor to be stated (no default)', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await expect(
        db.query(
          `INSERT INTO autorizaciones_imagen (cliente_id, persona_nombre, alcance, vigente_hasta, documento_clave)
           VALUES ($1, 'Persona Ficticia', 'Redes', now() + interval '1 year', 'doc.pdf')`,
          [cliente.id],
        ),
      ).rejects.toMatchObject({ code: '23502' });
    });
  });

  it('accepts es_menor true and false, with false as the factory default', async () => {
    await withTestTransaction(async (db) => {
      expect((await createAutorizacionImagen(db)).es_menor).toBe(false);
      expect((await createAutorizacionImagen(db, { esMenor: true })).es_menor).toBe(true);
    });
  });

  it('rejects blank persona_nombre, alcance and documento_clave', async () => {
    for (const overrides of [{ personaNombre: ' ' }, { alcance: '' }, { documentoClave: '  ' }]) {
      await withTestTransaction(async (db) => {
        await expect(createAutorizacionImagen(db, overrides)).rejects.toMatchObject({ code: '23514' });
      });
    }
  });

  it('rejects vigente_hasta that is not later than vigente_desde', async () => {
    const desde = new Date(NOW - DAY_MS);
    await withTestTransaction(async (db) => {
      await expect(
        createAutorizacionImagen(db, { vigenteDesde: desde, vigenteHasta: desde }),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('requires vigente_hasta', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await expect(
        db.query(
          `INSERT INTO autorizaciones_imagen (cliente_id, persona_nombre, alcance, documento_clave, es_menor)
           VALUES ($1, 'Persona Ficticia', 'Redes', 'doc.pdf', false)`,
          [cliente.id],
        ),
      ).rejects.toMatchObject({ code: '23502' });
    });
  });

  it('enforces the revocada_en check', async () => {
    const desde = new Date(NOW - DAY_MS);
    await withTestTransaction(async (db) => {
      await expect(
        createAutorizacionImagen(db, { vigenteDesde: desde, revocadaEn: new Date(NOW - 2 * DAY_MS) }),
      ).rejects.toMatchObject({ code: '23514' });
    });
    for (const revocadaEn of [desde, new Date(NOW - 60 * 1000), null]) {
      await withTestTransaction(async (db) => {
        await expect(createAutorizacionImagen(db, { vigenteDesde: desde, revocadaEn })).resolves.toBeDefined();
      });
    }
  });

  it('revoked option produces a row withdrawn in the past', async () => {
    await withTestTransaction(async (db) => {
      const row = await createAutorizacionImagen(db, { revoked: true });
      expect(row.revocada_en).not.toBeNull();
      expect(row.revocada_en!.getTime()).toBeLessThan(Date.now());
      expect(row.revocada_en!.getTime()).toBeGreaterThanOrEqual(row.vigente_desde.getTime());
      expect(row.vigente_hasta.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('expired option produces an already expired row', async () => {
    await withTestTransaction(async (db) => {
      const row = await createAutorizacionImagen(db, { expired: true });
      expect(row.vigente_hasta.getTime()).toBeLessThan(Date.now());
      expect(row.revocada_en).toBeNull();
    });
  });

  it('rejects an unknown cliente_id', async () => {
    await withTestTransaction(async (db) => {
      await expect(createAutorizacionImagen(db, { clienteId: UNKNOWN_ID })).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('keeps usuarios global: createUsuario still works without a client', async () => {
    await withTestTransaction(async (db) => {
      await expect(createUsuario(db)).resolves.toBeDefined();
    });
  });
});
