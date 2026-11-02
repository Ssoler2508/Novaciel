import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { assignRole, createPrecioModelo, createUsuario, uniqueSuffix } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { usdToMicro } from '../presupuesto/money.js';
import { computeCost, estimateCost, unitCost } from './costEstimation.js';
import { getPriceAt, getUnitPriceAt, PermissionDeniedError, PriceExistsError, PriceNotFoundError, setModelPrice, setUnitPrice } from './preciosRepository.js';

async function admin(db: Db) {
  const user = await createUsuario(db);
  await assignRole(db, { usuarioId: user.id, rolCodigo: 'administrador_novaciel' });
  return { tipo: 'usuario', usuarioId: user.id } as const;
}

function names() {
  const suffix = uniqueSuffix();
  return { provider: `fake_provider_${suffix}`, model: `fake-model-${suffix}` };
}

describe('prices by unit', () => {
  it('token prices keep working unchanged next to unit prices of the same provider and model', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      await createPrecioModelo(db, { proveedor: provider, modelo: model, precioEntrada: '3', precioSalida: '15' });
      await createPrecioModelo(db, { proveedor: provider, modelo: model, unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });
      expect(await estimateCost(db, { provider, model, maxInputTokens: 1_000_000, maxOutputTokens: 0 })).toBe(3_000_000n);
      expect(await computeCost(db, { provider, model, inputTokens: 1_234, outputTokens: 567 })).toBe(1_234n * 3n + 567n * 15n);
      const token = await getPriceAt(db, provider, model);
      expect(token.inputPerMillion).toBe(3_000_000n);
    });
  });

  it('unitCost is exact and rounds up, never down', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      await createPrecioModelo(db, { proveedor: provider, modelo: model, unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });
      const cost = (units: number) => unitCost(db, { provider, model, unit: 'caracteres', units });
      expect(await cost(1000)).toBe(80_000n); // USD 0.08
      expect(await cost(1)).toBe(80n); // 80 micro-USD per character
      expect(await cost(0)).toBe(0n);
      expect(await cost(1250)).toBe(100_000n);
      await createPrecioModelo(db, { proveedor: provider, modelo: `${model}-b`, unidad: 'segundos', precioPorBloque: '0.000001', tamanoBloque: 3 });
      // 1 micro-USD per 3 seconds: 1 second still costs 1, 4 seconds cost 2.
      expect(await unitCost(db, { provider, model: `${model}-b`, unit: 'segundos', units: 1 })).toBe(1n);
      expect(await unitCost(db, { provider, model: `${model}-b`, unit: 'segundos', units: 4 })).toBe(2n);
    });
  });

  it('a model without a price in that unit is refused (PriceNotFoundError), even if it has a token price', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      await createPrecioModelo(db, { proveedor: provider, modelo: model });
      await expect(unitCost(db, { provider, model, unit: 'caracteres', units: 10 })).rejects.toThrow(PriceNotFoundError);
      await expect(getUnitPriceAt(db, provider, model, 'imagenes')).rejects.toThrow(PriceNotFoundError);
      // And the other way round: a unit price is not a token price.
      const other = names();
      await createPrecioModelo(db, { proveedor: other.provider, modelo: other.model, unidad: 'caracteres' });
      await expect(getPriceAt(db, other.provider, other.model)).rejects.toThrow(PriceNotFoundError);
      await expect(estimateCost(db, { provider: other.provider, model: other.model, maxInputTokens: 1, maxOutputTokens: 1 })).rejects.toThrow(PriceNotFoundError);
    });
  });

  it('the database refuses a row that mixes the two column pairs, and a block size of zero', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      const user = await createUsuario(db);
      const insert = `INSERT INTO precios_modelos (proveedor, modelo, unidad, precio_entrada_por_millon, precio_salida_por_millon, precio_por_bloque, tamano_bloque, creado_por)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
      const cases: [string, unknown[]][] = [
        ['tokens_with_block', ['tokens', '1', '2', '0.08', 1000]],
        ['tokens_without_prices', ['tokens', null, null, null, null]],
        ['chars_with_token_prices', ['caracteres', '1', '2', '0.08', 1000]],
        ['chars_without_block', ['caracteres', null, null, null, null]],
        ['chars_zero_block', ['caracteres', null, null, '0.08', 0]],
        ['unknown_unit', ['palabras', null, null, '0.08', 1000]],
      ];
      for (const [name, values] of cases) {
        await db.query(`SAVEPOINT ${name}`);
        await expect(db.query(insert, [provider, model, ...values, user.id]), name).rejects.toThrow();
        await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
      }
    });
  });

  it('setUnitPrice needs manage_budget, audits the row and never updates: a duplicate is refused', async () => {
    await withTestTransaction(async (db) => {
      const { provider, model } = names();
      const actor = await admin(db);
      const price = await setUnitPrice(db, { provider, model, unit: 'caracteres', pricePerBlock: usdToMicro('0.08'), blockSize: 1000, nota: 'FAKE' }, actor);
      expect(price).toMatchObject({ unit: 'caracteres', pricePerBlock: 80_000n, blockSize: 1000n });
      expect(await auditRowsFor(db, 'precios_modelos', price.id)).toHaveLength(1);
      await expect(setUnitPrice(db, { provider, model, unit: 'caracteres', pricePerBlock: 1n, blockSize: 1000 }, actor)).rejects.toThrow(PriceExistsError);
      // The same instant for tokens is a different price.
      await expect(setModelPrice(db, { provider, model, inputPerMillion: 1n, outputPerMillion: 1n }, actor)).resolves.toBeDefined();

      const operator = await createUsuario(db);
      await assignRole(db, { usuarioId: operator.id, rolCodigo: 'operador_novaciel' });
      await expect(
        setUnitPrice(db, { provider, model: `${model}-x`, unit: 'caracteres', pricePerBlock: 1n, blockSize: 1000 }, { tipo: 'usuario', usuarioId: operator.id }),
      ).rejects.toThrow(PermissionDeniedError);
      await expect(setUnitPrice(db, { provider, model, unit: 'caracteres', pricePerBlock: 1n, blockSize: 0 }, actor)).rejects.toThrow(/blockSize/);
      await expect(setUnitPrice(db, { provider, model, unit: 'tokens' as never, pricePerBlock: 1n, blockSize: 1 }, actor)).rejects.toThrow(/other than tokens/);
    });
  });

  it('unit price rows are immutable like token price rows', async () => {
    await withTestTransaction(async (db) => {
      const row = await createPrecioModelo(db, { unidad: 'caracteres' });
      await db.query('SAVEPOINT u');
      await expect(db.query('UPDATE precios_modelos SET precio_por_bloque = 1 WHERE id = $1', [row.id])).rejects.toThrow(/never changed/);
      await db.query('ROLLBACK TO SAVEPOINT u');
      await db.query('SAVEPOINT d');
      await expect(db.query('DELETE FROM precios_modelos WHERE id = $1', [row.id])).rejects.toThrow(/never changed/);
      await db.query('ROLLBACK TO SAVEPOINT d');
    });
  });
});
