import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { estimateCost } from '../modules/precios/costEstimation.js';
import { getSpendSummary } from '../modules/presupuesto/presupuestoService.js';
import { asClienteId } from '../modules/shared/clienteId.js';
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

describe('seed: spending ceiling', () => {
  it('gives the fictional client a USD 1 default ceiling once, audited, without touching hand edits', async () => {
    await withTestTransaction(async (db) => {
      const first = await seedDevelopment(db);
      expect(first.created).toContain('configuración de gasto: techo mensual USD 1');
      const { rows } = await db.query(`SELECT cliente_id, gasto_habilitado, techo_mensual_defecto::text AS techo FROM configuracion_gasto_cliente`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ gasto_habilitado: true, techo: '1.000000' });
      const clienteId = asClienteId(rows[0].cliente_id);
      expect(await getSpendSummary(db, clienteId)).toMatchObject({ ceiling: 1_000_000n, spent: 0n, remaining: 1_000_000n });

      await db.query('UPDATE configuracion_gasto_cliente SET techo_mensual_defecto = 5');
      const second = await seedDevelopment(db);
      expect(second.created).toEqual([]);
      expect((await db.query('SELECT techo_mensual_defecto::text AS techo FROM configuracion_gasto_cliente')).rows[0].techo).toBe('5.000000');
      const audit = await db.query(`SELECT 1 FROM auditoria WHERE tabla = 'configuracion_gasto_cliente'`);
      expect(audit.rows).toHaveLength(1);
    });
  });
});
