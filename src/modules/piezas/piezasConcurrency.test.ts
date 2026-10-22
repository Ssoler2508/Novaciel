import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { createCliente, createPieza, createPlanSemanal } from '../../../tests/utils/factories/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { getHistorial, getPieza, InvalidTransitionError, pausarPieza, reanudarPieza, transitionPieza, type EstadoPieza } from './index.js';

const SISTEMA = { tipo: 'sistema' } as const;

// Real, separate connections: this test commits, so it cleans up with cleanupDomainTables.
// (The history rows it commits cannot be deleted: the table is append-only, like libro_gastos.)
describe('concurrent transitions of the same piece', () => {
  beforeEach(async () => {
    await cleanupDomainTables(getTestPool());
  });
  afterAll(async () => {
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  async function pieceIn(estado: EstadoPieza) {
    const pool = getTestPool();
    const clienteId = asClienteId((await createCliente(pool)).id);
    const plan = await createPlanSemanal(pool, { clienteId });
    const pieza = await createPieza(pool, { clienteId, planId: plan.id, estado });
    return { pool, clienteId, pieza };
  }

  it('two parallel transitions to different targets: exactly one wins, the other sees the new state', async () => {
    // Targets that the approval guard of Step 9 does not cover (it guards aprobada and programada).
    const { pool, clienteId, pieza } = await pieceIn('esperando_aprobacion');
    const before = await getHistorial(pool, clienteId, pieza.id);

    const results = await Promise.allSettled([
      transitionPieza(pool, clienteId, pieza.id, 'con_cambios', SISTEMA),
      transitionPieza(pool, clienteId, pieza.id, 'rechazada', SISTEMA),
    ]);
    const winners = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof transitionPieza>>> => r.status === 'fulfilled');
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBeInstanceOf(InvalidTransitionError);

    const winner = winners[0]!.value;
    const after = (await getPieza(pool, clienteId, pieza.id))!;
    expect(after.estado).toBe(winner.estado);
    expect(['con_cambios', 'rechazada']).toContain(after.estado);
    expect(after.version_estado).toBe(pieza.version_estado + 1);
    const history = await getHistorial(pool, clienteId, pieza.id);
    expect(history).toHaveLength(before.length + 1);
    expect(history.at(-1)).toMatchObject({ desde: 'esperando_aprobacion', hacia: after.estado });
  });

  it('several parallel identical transitions: exactly one succeeds', async () => {
    const { pool, clienteId, pieza } = await pieceIn('esperando_aprobacion');
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => transitionPieza(pool, clienteId, pieza.id, 'con_cambios', SISTEMA)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(InvalidTransitionError);
    const after = (await getPieza(pool, clienteId, pieza.id))!;
    expect(after).toMatchObject({ estado: 'con_cambios', version_estado: pieza.version_estado + 1 });
    expect(await getHistorial(pool, clienteId, pieza.id)).toHaveLength(pieza.version_estado + 2);
  });

  it('a pause racing a transition leaves a consistent piece, and resume still returns to where it was paused', async () => {
    const { pool, clienteId, pieza } = await pieceIn('en_produccion');
    const results = await Promise.allSettled([
      pausarPieza(pool, clienteId, pieza.id, SISTEMA),
      transitionPieza(pool, clienteId, pieza.id, 'en_control_calidad', SISTEMA),
    ]);
    // Both are valid from 'en_produccion', so whichever runs second may also succeed (en_control_calidad -> pausada,
    // or pausada can no longer go to en_control_calidad). Either way the piece is consistent.
    const after = (await getPieza(pool, clienteId, pieza.id))!;
    expect(['pausada', 'en_control_calidad']).toContain(after.estado);
    const history = await getHistorial(pool, clienteId, pieza.id);
    expect(history.map((h) => h.version)).toEqual(Array.from({ length: history.length }, (_v, i) => i));
    expect(after.version_estado).toBe(history.length - 1);
    if (after.estado === 'pausada') {
      const resumed = await reanudarPieza(pool, clienteId, pieza.id, SISTEMA);
      expect(resumed.estado).toBe(after.estado_previo);
    }
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });
});
