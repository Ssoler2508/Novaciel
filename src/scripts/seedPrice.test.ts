import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { estimateCost } from '../modules/precios/costEstimation.js';
import { seedDevelopment, SEED_PRICE_MODEL, SEED_PRICE_NOTE, SEED_PRICE_PROVIDER } from './seedDevelopment.js';

describe('seed: fake model price', () => {
  it('creates one clearly fake price once, usable for estimates, audited once', async () => {
    await withTestTransaction(async (db) => {
      const first = await seedDevelopment(db);
      expect(first.created).toContain(`precio ficticio ${SEED_PRICE_PROVIDER}/${SEED_PRICE_MODEL}`);
      const second = await seedDevelopment(db);
      expect(second.created).toEqual([]);

      const { rows } = await db.query('SELECT nota, precio_entrada_por_millon::text AS entrada FROM precios_modelos WHERE proveedor = $1 AND modelo = $2', [
        SEED_PRICE_PROVIDER,
        SEED_PRICE_MODEL,
      ]);
      expect(rows).toEqual([{ nota: SEED_PRICE_NOTE, entrada: '1.000000' }]);
      const audit = await db.query(`SELECT 1 FROM auditoria WHERE tabla = 'precios_modelos' AND accion = 'crear'`);
      expect(audit.rows).toHaveLength(1);
      await expect(
        estimateCost(db, { provider: SEED_PRICE_PROVIDER, model: SEED_PRICE_MODEL, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 }),
      ).resolves.toBe(3_000_000n);
    });
  });
});
