import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { assignRole, createCliente, createPrecioModelo, createUsuario, uniqueSuffix } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { usdToMicro } from '../presupuesto/money.js';
import { computeCost, estimateCost } from './costEstimation.js';
import {
  getPriceAt,
  PermissionDeniedError,
  PriceActorError,
  PriceExistsError,
  PriceNotFoundError,
  setModelPrice,
} from './preciosRepository.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function admin(db: Db) {
  const user = await createUsuario(db);
  await assignRole(db, { usuarioId: user.id, rolCodigo: 'administrador_novaciel' });
  return { tipo: 'usuario', usuarioId: user.id } as const;
}

function names() {
  const suffix = uniqueSuffix();
  return { provider: `fake_provider_${suffix}`, model: `fake-model-${suffix}` };
}

describe('estimateCost and computeCost', () => {
  it('are exact to the micro-dollar', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      await createPrecioModelo(db, { proveedor: provider, modelo: model, precioEntrada: '3', precioSalida: '15' });
      // 1,000,000 input tokens at 3.00 per million = 3.00 USD.
      expect(await estimateCost(db, { provider, model, maxInputTokens: 1_000_000, maxOutputTokens: 0 })).toBe(3_000_000n);
      expect(await estimateCost(db, { provider, model, maxInputTokens: 0, maxOutputTokens: 1_000_000 })).toBe(15_000_000n);
      // (1,234 * 3 + 567 * 15) micro-USD: 3,702 + 8,505 = 12,207.
      expect(await computeCost(db, { provider, model, inputTokens: 1_234, outputTokens: 567 })).toBe(1_234n * 3n + 567n * 15n);
    });
  });

  it('estimate rounds up, never down', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      await createPrecioModelo(db, { proveedor: provider, modelo: model, precioEntrada: '0.000001', precioSalida: '0.000001' });
      // 1 token at 0.000001 USD per million is a millionth of a micro-USD, and still costs 1.
      expect(await estimateCost(db, { provider, model, maxInputTokens: 1, maxOutputTokens: 0 })).toBe(1n);
      // 1,000,000 tokens is exactly 1 micro-USD: no spare unit.
      expect(await estimateCost(db, { provider, model, maxInputTokens: 1_000_000, maxOutputTokens: 0 })).toBe(1n);
      expect(await estimateCost(db, { provider, model, maxInputTokens: 1_000_001, maxOutputTokens: 0 })).toBe(2n);
      expect(await estimateCost(db, { provider, model, maxInputTokens: 0, maxOutputTokens: 0 })).toBe(0n);
    });
  });

  it('computeCost also rounds up, so actual never exceeds the estimate for usage within the maximum', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      await createPrecioModelo(db, { proveedor: provider, modelo: model, precioEntrada: '0.333333', precioSalida: '0.777777' });
      const estimate = await estimateCost(db, { provider, model, maxInputTokens: 1000, maxOutputTokens: 400 });
      const actual = await computeCost(db, { provider, model, inputTokens: 999, outputTokens: 399 });
      expect(actual).toBeLessThanOrEqual(estimate);
      expect(await computeCost(db, { provider, model, inputTokens: 1000, outputTokens: 400 })).toBe(estimate);
    });
  });

  it('finds a price created with the default vigente_desde when no `at` is given (database clock)', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      await createPrecioModelo(db, { proveedor: provider, modelo: model, precioEntrada: '2', precioSalida: '4' });
      await expect(estimateCost(db, { provider, model, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 })).resolves.toBe(6_000_000n);
      await expect(computeCost(db, { provider, model, inputTokens: 1_000_000, outputTokens: 0 })).resolves.toBe(2_000_000n);
    });
  });

  it('chooses the price valid at the given date', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      const base = Date.now();
      await createPrecioModelo(db, { proveedor: provider, modelo: model, precioEntrada: '1', precioSalida: '1', vigenteDesde: new Date(base - 10 * DAY_MS) });
      await createPrecioModelo(db, { proveedor: provider, modelo: model, precioEntrada: '2', precioSalida: '2', vigenteDesde: new Date(base - 2 * DAY_MS) });
      await createPrecioModelo(db, { proveedor: provider, modelo: model, precioEntrada: '5', precioSalida: '5', vigenteDesde: new Date(base + 5 * DAY_MS) });
      const million = { provider, model, maxInputTokens: 1_000_000, maxOutputTokens: 0 };
      expect(await estimateCost(db, { ...million, at: new Date(base - 5 * DAY_MS) })).toBe(1_000_000n);
      expect(await estimateCost(db, { ...million, at: new Date(base) })).toBe(2_000_000n);
      expect(await estimateCost(db, million)).toBe(2_000_000n); // future row is not valid yet
      expect(await estimateCost(db, { ...million, at: new Date(base + 6 * DAY_MS) })).toBe(5_000_000n);
      await expect(estimateCost(db, { ...million, at: new Date(base - 11 * DAY_MS) })).rejects.toThrow(PriceNotFoundError);
    });
  });

  it('throws PriceNotFoundError for an unpriced model, and for a different provider', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      await createPrecioModelo(db, { proveedor: provider, modelo: model });
      await expect(estimateCost(db, { provider, model: 'other-model', maxInputTokens: 1, maxOutputTokens: 1 })).rejects.toThrow(PriceNotFoundError);
      await expect(computeCost(db, { provider: 'other_provider', model, inputTokens: 1, outputTokens: 1 })).rejects.toThrow(PriceNotFoundError);
    });
  });

  it('rejects invalid token counts', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      await createPrecioModelo(db, { proveedor: provider, modelo: model });
      for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        await expect(estimateCost(db, { provider, model, maxInputTokens: bad, maxOutputTokens: 1 })).rejects.toThrow();
        await expect(computeCost(db, { provider, model, inputTokens: 1, outputTokens: bad })).rejects.toThrow();
      }
    });
  });
});

describe('setModelPrice', () => {
  const input = () => ({ ...names(), inputPerMillion: usdToMicro('1.5'), outputPerMillion: usdToMicro('7.25'), nota: 'FAKE test price' });

  it('lets an administrator write a price, audited, and the price is then usable', async () => {
    await withTestTransaction(async (db) => {
      const actor = await admin(db);
      const price = await setModelPrice(db, input(), actor);
      expect(price).toMatchObject({ inputPerMillion: 1_500_000n, outputPerMillion: 7_250_000n, nota: 'FAKE test price' });
      expect((await getPriceAt(db, price.provider, price.model)).id).toBe(price.id);
      const audit = await auditRowsFor(db, 'precios_modelos', price.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ accion: 'crear', actor_tipo: 'usuario', actor_usuario_id: actor.usuarioId, cliente_id: null });
      expect(audit[0]!.datos_despues).toMatchObject({ precio_entrada_por_millon: '1.500000', precio_salida_por_millon: '7.250000' });
    });
  });

  it('refuses everyone without manage_budget and writes nothing', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const operator = await createUsuario(db);
      await assignRole(db, { usuarioId: operator.id, rolCodigo: 'operador_novaciel' });
      const owner = await createUsuario(db);
      await assignRole(db, { usuarioId: owner.id, rolCodigo: 'dueno_cliente', clienteId: cliente.id });
      const nobody = await createUsuario(db);
      const before = Number((await db.query('SELECT count(*) AS n FROM precios_modelos')).rows[0].n);
      const auditBefore = Number((await db.query(`SELECT count(*) AS n FROM auditoria WHERE tabla = 'precios_modelos'`)).rows[0].n);
      for (const user of [operator, owner, nobody]) {
        await expect(setModelPrice(db, input(), { tipo: 'usuario', usuarioId: user.id })).rejects.toThrow(PermissionDeniedError);
      }
      await expect(setModelPrice(db, input(), { tipo: 'sistema' })).rejects.toThrow(PriceActorError);
      expect(Number((await db.query('SELECT count(*) AS n FROM precios_modelos')).rows[0].n)).toBe(before);
      expect(Number((await db.query(`SELECT count(*) AS n FROM auditoria WHERE tabla = 'precios_modelos'`)).rows[0].n)).toBe(auditBefore);
    });
  });

  it('a price change is a new row; the same provider, model and date is refused', async () => {
    await withTestTransaction(async (db) => {
      const actor = await admin(db);
      const { provider, model } = names();
      const at = new Date(Date.now() - DAY_MS);
      await setModelPrice(db, { provider, model, inputPerMillion: 1n, outputPerMillion: 1n, vigenteDesde: at }, actor);
      await expect(
        setModelPrice(db, { provider, model, inputPerMillion: 2n, outputPerMillion: 2n, vigenteDesde: at }, actor),
      ).rejects.toThrow(PriceExistsError);
      await setModelPrice(db, { provider, model, inputPerMillion: 2n, outputPerMillion: 2n }, actor);
      expect((await db.query('SELECT 1 FROM precios_modelos WHERE proveedor = $1 AND modelo = $2', [provider, model])).rows).toHaveLength(2);
    });
  });

  it('rejects negative amounts', async () => {
    await withTestTransaction(async (db) => {
      const actor = await admin(db);
      await expect(setModelPrice(db, { ...names(), inputPerMillion: -1n, outputPerMillion: 1n }, actor)).rejects.toThrow();
    });
  });
});

describe('precios_modelos table', () => {
  it('rejects UPDATE and DELETE', async () => {
    await withTestTransaction(async (db) => {
      const row = await createPrecioModelo(db);
      await expect(db.query('UPDATE precios_modelos SET precio_entrada_por_millon = 0 WHERE id = $1', [row.id])).rejects.toThrow(/never changed/);
    });
    await withTestTransaction(async (db) => {
      const row = await createPrecioModelo(db);
      await expect(db.query('DELETE FROM precios_modelos WHERE id = $1', [row.id])).rejects.toThrow(/never changed/);
    });
  });

  it('rejects negative prices and blank names', async () => {
    await withTestTransaction(async (db) => {
      await expect(createPrecioModelo(db, { precioEntrada: '-0.000001' })).rejects.toMatchObject({ code: '23514' });
    });
    await withTestTransaction(async (db) => {
      await expect(createPrecioModelo(db, { modelo: '  ' })).rejects.toMatchObject({ code: '23514' });
    });
  });
});
