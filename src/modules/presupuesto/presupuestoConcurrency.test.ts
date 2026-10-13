import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { createCliente, createConfiguracionGastoCliente, createTope } from '../../../tests/utils/factories/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { usdToMicro } from './money.js';
import { authorize, BudgetRefusedError, getSpendSummary } from './presupuestoService.js';

const SISTEMA = { tipo: 'sistema' } as const;

// Real, separate connections: this test commits, so it cleans up with cleanupDomainTables.
describe('authorize under concurrency', () => {
  beforeEach(async () => {
    await cleanupDomainTables(getTestPool());
  });
  afterAll(async () => {
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  async function race(n: number, cost: string, setup: (clienteId: string) => Promise<unknown>) {
    const pool = getTestPool();
    const clienteId = asClienteId((await createCliente(pool)).id);
    await setup(clienteId);
    const results = await Promise.allSettled(
      Array.from({ length: n }, () =>
        authorize(pool, clienteId, { estimatedCost: usdToMicro(cost), purpose: 'p', provider: 'fake_provider', model: 'fake-model' }, SISTEMA),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(BudgetRefusedError);
    }
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    return { pool, clienteId, accepted, refused: n - accepted };
  }

  it('never accepts more than the ceiling allows (explicit ceiling row)', async () => {
    // 12 x 1.00 against a 5.00 ceiling: exactly 5 fit.
    const { pool, clienteId, accepted, refused } = await race(12, '1', (id) =>
      createTope(getTestPool(), { clienteId: id, montoTecho: '5' }),
    );
    expect(accepted).toBe(5);
    expect(refused).toBe(7);
    const summary = await getSpendSummary(pool, clienteId);
    expect(summary.reserved).toBe(5_000_000n);
    expect(summary.remaining).toBe(0n);
  });

  it('is safe when the first racers create the ceiling row from the default', async () => {
    const { pool, clienteId, accepted } = await race(10, '1', (id) =>
      createConfiguracionGastoCliente(getTestPool(), { clienteId: id, techoMensualDefecto: '3' }),
    );
    expect(accepted).toBe(3);
    expect((await pool.query('SELECT 1 FROM topes WHERE cliente_id = $1', [clienteId])).rows).toHaveLength(1);
  });
});
