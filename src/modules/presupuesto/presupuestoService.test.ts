import { describe, expect, it, vi } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import {
  createAutorizacionGasto,
  createCliente,
  createConfiguracionGastoCliente,
  createLibroGasto,
  createTope,
  currentPeriodo,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { logger } from '../../lib/logger/index.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { usdToMicro } from './money.js';
import {
  AuthorizationNotFoundError,
  AuthorizationStateError,
  authorize,
  BudgetRefusedError,
  expireStaleReservations,
  getSpendSummary,
  release,
  settle,
  type AuthorizeRequest,
  type BudgetRefusalReason,
  type SpendAuthorization,
} from './presupuestoService.js';

const SISTEMA = { tipo: 'sistema' } as const;

function request(cost: string, overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest {
  return { estimatedCost: usdToMicro(cost), purpose: 'test_purpose', provider: 'fake_provider', model: 'fake-model', ...overrides };
}

async function clientWithCeiling(db: Db, ceiling = '10'): Promise<ClienteId> {
  const id = asClienteId((await createCliente(db)).id);
  await createTope(db, { clienteId: id, montoTecho: ceiling });
  return id;
}

async function refusalOf(promise: Promise<unknown>): Promise<BudgetRefusalReason> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BudgetRefusedError) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('authorize', () => {
  it('reserves within the ceiling and audits it', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '10');
      const auth = await authorize(db, clienteId, request('4.5'), SISTEMA);
      expect(auth).toMatchObject({ clienteId, estimatedCost: 4_500_000n, purpose: 'test_purpose' });
      const { rows } = await db.query('SELECT estado FROM autorizaciones_gasto WHERE id = $1', [auth.id]);
      expect(rows[0].estado).toBe('reservada');
      const audit = await auditRowsFor(db, 'autorizaciones_gasto', auth.id);
      expect(audit.map((a) => a.accion)).toEqual(['autorizar']);
      expect(audit[0]).toMatchObject({ cliente_id: clienteId, actor_tipo: 'sistema' });
    });
  });

  it('accepts exactly the ceiling and refuses one micro-dollar more', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '1');
      await authorize(db, clienteId, request('0.999999'), SISTEMA);
      await authorize(db, clienteId, request('0.000001'), SISTEMA);
      expect(await refusalOf(authorize(db, clienteId, request('0.000001'), SISTEMA))).toBe('techo_superado');
    });
  });

  it('counts settled ledger spend and active reservations together', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '10');
      await createLibroGasto(db, { clienteId, costoReal: '6' });
      await createAutorizacionGasto(db, { clienteId, montoEstimado: '3' });
      await authorize(db, clienteId, request('1'), SISTEMA);
      expect(await refusalOf(authorize(db, clienteId, request('0.000001'), SISTEMA))).toBe('techo_superado');
    });
  });

  it('refuses over the ceiling and audits the refusal without reserving', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '1');
      expect(await refusalOf(authorize(db, clienteId, request('1.5'), SISTEMA))).toBe('techo_superado');
      const { rows } = await db.query('SELECT 1 FROM autorizaciones_gasto WHERE cliente_id = $1', [clienteId]);
      expect(rows).toHaveLength(0);
      const audit = await db.query(`SELECT * FROM auditoria WHERE cliente_id = $1 AND accion = 'rechazar_gasto'`, [clienteId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].datos_despues).toMatchObject({ motivo: 'techo_superado', monto_estimado: '1.500000' });
    });
  });

  it('refuses when the client has no ceiling and no default (sin_techo)', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      expect(await refusalOf(authorize(db, clienteId, request('0'), SISTEMA))).toBe('sin_techo');
      await createConfiguracionGastoCliente(db, { clienteId, techoMensualDefecto: null });
      expect(await refusalOf(authorize(db, clienteId, request('0'), SISTEMA))).toBe('sin_techo');
    });
  });

  it('creates the period ceiling from the client default on first use', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      await createConfiguracionGastoCliente(db, { clienteId, techoMensualDefecto: '2' });
      await authorize(db, clienteId, request('1.5'), SISTEMA);
      const { rows } = await db.query(`SELECT id, monto_techo, periodo::text AS periodo FROM topes WHERE cliente_id = $1`, [clienteId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ monto_techo: '2.000000', periodo: currentPeriodo() });
      const audit = await auditRowsFor(db, 'topes', rows[0].id);
      expect(audit.map((a) => a.accion)).toEqual(['crear']);
      expect(await refusalOf(authorize(db, clienteId, request('0.6'), SISTEMA))).toBe('techo_superado');
      // The ceiling row is created once, not per authorization.
      expect((await db.query('SELECT 1 FROM topes WHERE cliente_id = $1', [clienteId])).rows).toHaveLength(1);
    });
  });

  it('an explicit topes row wins over the default', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '1');
      await createConfiguracionGastoCliente(db, { clienteId, techoMensualDefecto: '100' });
      expect(await refusalOf(authorize(db, clienteId, request('2'), SISTEMA))).toBe('techo_superado');
    });
  });

  it('the client switch refuses, and other clients are unaffected', async () => {
    await withTestTransaction(async (db) => {
      const a = await clientWithCeiling(db);
      const b = await clientWithCeiling(db);
      await createConfiguracionGastoCliente(db, { clienteId: a, gastoHabilitado: false });
      expect(await refusalOf(authorize(db, a, request('1'), SISTEMA))).toBe('interruptor_cliente');
      await expect(authorize(db, b, request('1'), SISTEMA)).resolves.toBeDefined();
    });
  });

  it('the global switch refuses every client', async () => {
    await withTestTransaction(async (db) => {
      const a = await clientWithCeiling(db);
      const b = await clientWithCeiling(db);
      await db.query('UPDATE interruptor_global SET gasto_habilitado = false');
      expect(await refusalOf(authorize(db, a, request('1'), SISTEMA))).toBe('interruptor_global');
      expect(await refusalOf(authorize(db, b, request('1'), SISTEMA))).toBe('interruptor_global');
      const audit = await db.query(`SELECT 1 FROM auditoria WHERE accion = 'rechazar_gasto' AND cliente_id = ANY($1)`, [[a, b]]);
      expect(audit.rows).toHaveLength(2);
    });
  });

  it('rejects an invalid estimate before touching the database', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db);
      await expect(authorize(db, clienteId, { ...request('1'), estimatedCost: -1n }, SISTEMA)).rejects.toThrow();
      await expect(authorize(db, clienteId, { ...request('1'), estimatedCost: 1.5 as never }, SISTEMA)).rejects.toThrow();
    });
  });
});

describe('settle', () => {
  async function authorized(db: Db, cost = '1', ceiling = '10') {
    const clienteId = await clientWithCeiling(db, ceiling);
    return { clienteId, auth: await authorize(db, clienteId, request(cost), SISTEMA) };
  }

  it('closes the reservation, writes one ledger row and audits', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, auth } = await authorized(db, '1');
      await settle(db, auth, { actualCost: usdToMicro('0.75'), inputUnits: 120, outputUnits: 30, outcome: 'ok' }, SISTEMA);
      const ledger = await db.query('SELECT * FROM libro_gastos WHERE autorizacion_id = $1', [auth.id]);
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0]).toMatchObject({
        cliente_id: clienteId,
        costo_real: '0.750000',
        unidades_entrada: '120',
        unidades_salida: '30',
        resultado: 'ok',
        proveedor: 'fake_provider',
        modelo: 'fake-model',
        proposito: 'test_purpose',
      });
      const { rows } = await db.query('SELECT estado, liquidada_en FROM autorizaciones_gasto WHERE id = $1', [auth.id]);
      expect(rows[0].estado).toBe('liquidada');
      expect(rows[0].liquidada_en).not.toBeNull();
      const audit = await auditRowsFor(db, 'autorizaciones_gasto', auth.id);
      expect(audit.map((a) => a.accion)).toEqual(['autorizar', 'liquidar']);
      expect(audit[1]!.datos_antes).toEqual({ estado: 'reservada' });
    });
  });

  it('only works once per authorization', async () => {
    await withTestTransaction(async (db) => {
      const { auth } = await authorized(db);
      const input = { actualCost: usdToMicro('0.5'), inputUnits: 1, outputUnits: 1, outcome: 'ok' } as const;
      await settle(db, auth, input, SISTEMA);
      await expect(settle(db, auth, input, SISTEMA)).rejects.toThrow(AuthorizationStateError);
      expect((await db.query('SELECT 1 FROM libro_gastos WHERE autorizacion_id = $1', [auth.id])).rows).toHaveLength(1);
    });
  });

  it('records an actual cost above the estimate and logs a metadata-only warning', async () => {
    await withTestTransaction(async (db) => {
      const { auth } = await authorized(db, '1');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      try {
        await settle(db, auth, { actualCost: usdToMicro('1.25'), inputUnits: 1, outputUnits: 1, outcome: 'ok' }, SISTEMA);
        expect(warn).toHaveBeenCalledTimes(1);
        const meta = warn.mock.calls[0]![0] as Record<string, unknown>;
        expect(meta).toMatchObject({ authorizationId: auth.id, estimatedCost: '1.000000', actualCost: '1.250000' });
      } finally {
        warn.mockRestore();
      }
      const { rows } = await db.query('SELECT costo_real FROM libro_gastos WHERE autorizacion_id = $1', [auth.id]);
      expect(rows[0].costo_real).toBe('1.250000');
    });
  });

  it('records the three outcomes', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '10');
      for (const outcome of ['ok', 'schema_invalido', 'error'] as const) {
        const auth = await authorize(db, clienteId, request('0.1'), SISTEMA);
        await settle(db, auth, { actualCost: 0n, inputUnits: 0, outputUnits: 0, outcome }, SISTEMA);
      }
      const { rows } = await db.query('SELECT resultado FROM libro_gastos WHERE cliente_id = $1 ORDER BY id', [clienteId]);
      expect(rows.map((r) => r.resultado)).toEqual(['ok', 'schema_invalido', 'error']);
    });
  });

  it('can settle an expired reservation (the money was spent) but not a released one', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db);
      const stale = await createAutorizacionGasto(db, { clienteId, expiraEnSegundos: -30 });
      await expireStaleReservations(db);
      const asAuth: SpendAuthorization = {
        id: stale.id,
        clienteId,
        periodo: currentPeriodo(),
        estimatedCost: 1_000_000n,
        purpose: 'test_purpose',
        provider: 'fake_provider',
        model: 'fake-model',
        expiraEn: stale.expira_en,
      };
      await settle(db, asAuth, { actualCost: 500_000n, inputUnits: 1, outputUnits: 1, outcome: 'ok' }, SISTEMA);
      expect((await auditRowsFor(db, 'autorizaciones_gasto', stale.id)).at(-1)!.datos_antes).toEqual({ estado: 'vencida' });

      const released = await authorize(db, clienteId, request('1'), SISTEMA);
      await release(db, released, SISTEMA);
      await expect(
        settle(db, released, { actualCost: 0n, inputUnits: 0, outputUnits: 0, outcome: 'error' }, SISTEMA),
      ).rejects.toThrow(AuthorizationStateError);
    });
  });

  it('rejects invalid amounts and units', async () => {
    await withTestTransaction(async (db) => {
      const { auth } = await authorized(db);
      await expect(settle(db, auth, { actualCost: -1n, inputUnits: 0, outputUnits: 0, outcome: 'ok' }, SISTEMA)).rejects.toThrow();
      await expect(settle(db, auth, { actualCost: 1n, inputUnits: -1, outputUnits: 0, outcome: 'ok' }, SISTEMA)).rejects.toThrow();
      await expect(settle(db, auth, { actualCost: 1n, inputUnits: 1.5, outputUnits: 0, outcome: 'ok' }, SISTEMA)).rejects.toThrow();
    });
  });
});

describe('release', () => {
  it('frees the amount so it can be reserved again, and audits', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '1');
      const first = await authorize(db, clienteId, request('1'), SISTEMA);
      expect(await refusalOf(authorize(db, clienteId, request('0.1'), SISTEMA))).toBe('techo_superado');
      await release(db, first, SISTEMA);
      await expect(authorize(db, clienteId, request('1'), SISTEMA)).resolves.toBeDefined();
      expect((await auditRowsFor(db, 'autorizaciones_gasto', first.id)).map((a) => a.accion)).toEqual(['autorizar', 'liberar']);
    });
  });

  it('only works once and not after settling', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db);
      const a = await authorize(db, clienteId, request('1'), SISTEMA);
      await release(db, a, SISTEMA);
      await expect(release(db, a, SISTEMA)).rejects.toThrow(AuthorizationStateError);
      const b = await authorize(db, clienteId, request('1'), SISTEMA);
      await settle(db, b, { actualCost: 1n, inputUnits: 0, outputUnits: 0, outcome: 'ok' }, SISTEMA);
      await expect(release(db, b, SISTEMA)).rejects.toThrow(AuthorizationStateError);
    });
  });
});

describe('expireStaleReservations', () => {
  it('expires only overdue reservations, audits them, and frees their budget', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '1');
      const stale = await createAutorizacionGasto(db, { clienteId, montoEstimado: '1', expiraEnSegundos: -30 });
      // The expired one no longer counts, even before the job runs.
      const fresh = await authorize(db, clienteId, request('1'), SISTEMA);
      const settledAlready = await createAutorizacionGasto(db, { clienteId, estado: 'liquidada', expiraEnSegundos: -30 });

      expect(await expireStaleReservations(db)).toBe(1);

      const states = await db.query('SELECT id, estado FROM autorizaciones_gasto WHERE cliente_id = $1', [clienteId]);
      const byId = Object.fromEntries(states.rows.map((r) => [r.id, r.estado]));
      expect(byId[stale.id]).toBe('vencida');
      expect(byId[fresh.id]).toBe('reservada');
      expect(byId[settledAlready.id]).toBe('liquidada');
      const audit = await auditRowsFor(db, 'autorizaciones_gasto', stale.id);
      expect(audit.map((a) => a.accion)).toEqual(['vencer']);
      expect(audit[0]).toMatchObject({ actor_tipo: 'sistema', cliente_id: clienteId });
      expect(await expireStaleReservations(db)).toBe(0);
    });
  });
});

describe('getSpendSummary', () => {
  it('has exact numbers with no float drift', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '1');
      await createLibroGasto(db, { clienteId, costoReal: '0.1' });
      await createLibroGasto(db, { clienteId, costoReal: '0.2' });
      await createAutorizacionGasto(db, { clienteId, montoEstimado: '0.123456' });
      await createAutorizacionGasto(db, { clienteId, montoEstimado: '5', expiraEnSegundos: -30 });
      await createAutorizacionGasto(db, { clienteId, montoEstimado: '5', estado: 'liberada' });
      const summary = await getSpendSummary(db, clienteId);
      expect(summary).toEqual({
        periodo: currentPeriodo(),
        ceiling: 1_000_000n,
        spent: 300_000n,
        reserved: 123_456n,
        remaining: 576_544n,
        percentUsed: 42.34,
      });
    });
  });

  it('reports 100% and zero remaining at or over the ceiling', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithCeiling(db, '1');
      await createLibroGasto(db, { clienteId, costoReal: '1.5' });
      const summary = await getSpendSummary(db, clienteId);
      expect(summary).toMatchObject({ remaining: 0n, percentUsed: 150 });
    });
  });

  it('uses the default when no period row exists and does not create one', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      await createConfiguracionGastoCliente(db, { clienteId, techoMensualDefecto: '4' });
      const summary = await getSpendSummary(db, clienteId);
      expect(summary).toMatchObject({ ceiling: 4_000_000n, spent: 0n, remaining: 4_000_000n, percentUsed: 0 });
      expect((await db.query('SELECT 1 FROM topes WHERE cliente_id = $1', [clienteId])).rows).toHaveLength(0);
    });
  });

  it('has null ceiling fields when there is no ceiling, and validates the period', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      expect(await getSpendSummary(db, clienteId)).toMatchObject({ ceiling: null, remaining: null, percentUsed: null });
      await expect(getSpendSummary(db, clienteId, '2026-10-15')).rejects.toThrow();
    });
  });

  it('can read another period', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      await createTope(db, { clienteId, periodo: '2026-01-01', montoTecho: '3' });
      await createLibroGasto(db, { clienteId, periodo: '2026-01-01', costoReal: '1' });
      const summary = await getSpendSummary(db, clienteId, '2026-01-01');
      expect(summary).toMatchObject({ ceiling: 3_000_000n, spent: 1_000_000n });
    });
  });
});

describe('isolation: budget', () => {
  it('a forged authorization for another client cannot settle or release it', async () => {
    await withTestTransaction(async (db) => {
      const a = await clientWithCeiling(db);
      const b = await clientWithCeiling(db);
      const authB = await authorize(db, b, request('1'), SISTEMA);
      const forged: SpendAuthorization = { ...authB, clienteId: a };
      await expect(
        settle(db, forged, { actualCost: 1n, inputUnits: 0, outputUnits: 0, outcome: 'ok' }, SISTEMA),
      ).rejects.toThrow(AuthorizationNotFoundError);
      await expect(release(db, forged, SISTEMA)).rejects.toThrow(AuthorizationNotFoundError);
      const { rows } = await db.query('SELECT estado FROM autorizaciones_gasto WHERE id = $1', [authB.id]);
      expect(rows[0].estado).toBe('reservada');
      expect((await db.query('SELECT 1 FROM libro_gastos WHERE autorizacion_id = $1', [authB.id])).rows).toHaveLength(0);
    });
  });

  it('spending of A never counts against B, and ledger rows keep the authorization client', async () => {
    await withTestTransaction(async (db) => {
      const a = await clientWithCeiling(db, '1');
      const b = await clientWithCeiling(db, '1');
      const authA = await authorize(db, a, request('1'), SISTEMA);
      await settle(db, authA, { actualCost: 1_000_000n, inputUnits: 1, outputUnits: 1, outcome: 'ok' }, SISTEMA);
      await expect(authorize(db, b, request('1'), SISTEMA)).resolves.toBeDefined();
      expect(await getSpendSummary(db, b)).toMatchObject({ spent: 0n, reserved: 1_000_000n });
      const { rows } = await db.query('SELECT cliente_id FROM libro_gastos WHERE autorizacion_id = $1', [authA.id]);
      expect(rows[0].cliente_id).toBe(a);
    });
  });
});
