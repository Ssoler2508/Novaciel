import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { producibleWorld } from '../../../tests/utils/produccionWorld.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { runInTransaction } from '../../db/transaction.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { producirPieza } from '../produccion/produccionService.js';
import { ejecutarQC } from './ejecutarQC.js';
import { QcEstadoInvalidoError } from './errors.js';

// Real, separate connections: this test commits, so it cleans up with cleanupDomainTables.
describe('two quality-control runs of the same piece at the same time', () => {
  beforeEach(async () => {
    await cleanupDomainTables(getTestPool());
  });
  afterAll(async () => {
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  it('exactly one wins and stores its report; the other finds the piece already moved and stores nothing', async () => {
    const pool = getTestPool();
    const w = await runInTransaction(pool, (tx) => producibleWorld(tx, { sinCifras: true }));
    await producirPieza({ db: pool, storage: w.storage }, w.clienteId, w.piezaId, { tipo: 'sistema' });

    const resultados = await Promise.allSettled([
      ejecutarQC({ db: pool, storage: w.storage }, w.clienteId, w.piezaId, { tipo: 'sistema' }),
      ejecutarQC({ db: pool, storage: w.storage }, w.clienteId, w.piezaId, { tipo: 'sistema' }),
    ]);
    const ganadores = resultados.filter((r) => r.status === 'fulfilled');
    const perdedores = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ganadores).toHaveLength(1);
    expect(perdedores).toHaveLength(1);
    expect(perdedores[0]!.reason).toBeInstanceOf(QcEstadoInvalidoError);

    expect((await getPieza(pool, w.clienteId, w.piezaId))!.estado).toBe('revision_novaciel');
    const informes = await pool.query('SELECT resultado FROM revisiones_calidad WHERE cliente_id = $1', [w.clienteId]);
    expect(informes.rows).toEqual([{ resultado: 'aprobado' }]);
    const auditoria = await pool.query("SELECT 1 FROM auditoria WHERE cliente_id = $1 AND accion = 'controlar_calidad'", [w.clienteId]);
    expect(auditoria.rows).toHaveLength(1);
  });
});
