import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runInTransaction } from '../../db/transaction.js';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { createActores, createPiezaAprobable } from '../../../tests/utils/factories/index.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { asClienteId } from '../shared/clienteId.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { listRegistros } from './aprobacionesRepository.js';
import { registrarDecision } from './aprobacionesService.js';
import { PiezaEstadoNoDecidibleError } from './errors.js';

// Real, separate connections: this test commits, so it cleans up with cleanupDomainTables.
describe('concurrent decisions on the same piece', () => {
  beforeEach(async () => {
    await cleanupDomainTables(getTestPool());
  });
  afterAll(async () => {
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  it('two parallel client decisions: exactly one wins, the other sees the new state, one client record is kept', async () => {
    const pool = getTestPool();
    // One transaction: a production and its files must be committed together.
    const w = await runInTransaction(pool, (tx) => createPiezaAprobable(tx, new FakeStorage()));
    const actores = await createActores(pool, w.clienteId);
    const clienteId = asClienteId(w.clienteId);
    await registrarDecision({ db: pool }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });

    const results = await Promise.allSettled([
      registrarDecision({ db: pool }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex }),
      registrarDecision({ db: pool }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'cambios', hashVisto: w.hashHex, motivo: 'texto' }),
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBeInstanceOf(PiezaEstadoNoDecidibleError);

    const estado = (await getPieza(pool, clienteId, w.piezaId))!.estado;
    expect(['aprobada', 'con_cambios']).toContain(estado);
    const clientRecords = (await listRegistros(pool, clienteId, w.piezaId)).filter((r) => r.nivel === 'cliente');
    expect(clientRecords).toHaveLength(1);
    expect(clientRecords[0]!.decision).toBe(estado === 'aprobada' ? 'aprobada' : 'cambios');
  });
});
