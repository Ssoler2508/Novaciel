import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  createAutorizacionGasto,
  createCliente,
  createConfiguracionGastoCliente,
  createLibroGasto,
  createTope,
} from '../../tests/utils/factories/index.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

describe('topes', () => {
  it('rejects a negative ceiling and accepts zero', async () => {
    await withTestTransaction(async (db) => {
      await expect(createTope(db, { montoTecho: '-0.000001' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createTope(db, { montoTecho: '0' })).resolves.toMatchObject({ monto_techo: '0.000000' });
    });
  });

  it('keeps micro-dollar precision without float drift', async () => {
    await withTestTransaction(async (db) => {
      const row = await createTope(db, { montoTecho: '0.123457' });
      expect(row.monto_techo).toBe('0.123457');
    });
  });

  it('rejects a period that is not the first day of a month', async () => {
    await withTestTransaction(async (db) => {
      await expect(createTope(db, { periodo: '2026-10-15' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('allows one ceiling per client and period', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await createTope(db, { clienteId: cliente.id, periodo: '2026-10-01' });
      await createTope(db, { clienteId: cliente.id, periodo: '2026-11-01' });
      await expect(createTope(db, { clienteId: cliente.id, periodo: '2026-10-01' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });

  it('requires an existing client', async () => {
    await withTestTransaction(async (db) => {
      await expect(createTope(db, { clienteId: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({ code: FK_VIOLATION });
    });
  });
});

describe('autorizaciones_gasto', () => {
  it('rejects a negative estimate', async () => {
    await withTestTransaction(async (db) => {
      await expect(createAutorizacionGasto(db, { montoEstimado: '-1' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('accepts the four states and rejects any other', async () => {
    for (const estado of ['reservada', 'liquidada', 'liberada', 'vencida'] as const) {
      await withTestTransaction(async (db) => {
        await expect(createAutorizacionGasto(db, { estado })).resolves.toMatchObject({ estado });
      });
    }
    await withTestTransaction(async (db) => {
      await expect(createAutorizacionGasto(db, { estado: 'cancelada' as never })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('sets liquidada_en only for settled reservations', async () => {
    await withTestTransaction(async (db) => {
      const settled = await createAutorizacionGasto(db, { estado: 'liquidada' });
      const open = await createAutorizacionGasto(db);
      expect(settled.liquidada_en).not.toBeNull();
      expect(open.liquidada_en).toBeNull();
      await expect(
        db.query(`UPDATE autorizaciones_gasto SET liquidada_en = now() WHERE id = $1`, [open.id]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('rejects an expiry that is not after the creation time', async () => {
    await withTestTransaction(async (db) => {
      const row = await createAutorizacionGasto(db);
      await expect(
        db.query(`UPDATE autorizaciones_gasto SET expira_en = creado_en WHERE id = $1`, [row.id]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('can be created already expired (for expiry tests)', async () => {
    await withTestTransaction(async (db) => {
      const row = await createAutorizacionGasto(db, { expiraEnSegundos: -30 });
      expect(row.expira_en.getTime()).toBeLessThan(Date.now());
    });
  });
});

describe('libro_gastos', () => {
  it('rejects negative cost and negative units', async () => {
    await withTestTransaction(async (db) => {
      await expect(createLibroGasto(db, { costoReal: '-0.01' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createLibroGasto(db, { unidadesEntrada: -1 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createLibroGasto(db, { unidadesSalida: -1 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('accepts the three outcomes and rejects any other', async () => {
    for (const resultado of ['ok', 'schema_invalido', 'error'] as const) {
      await withTestTransaction(async (db) => {
        await expect(createLibroGasto(db, { resultado })).resolves.toMatchObject({ resultado });
      });
    }
    await withTestTransaction(async (db) => {
      await expect(createLibroGasto(db, { resultado: 'fallo' as never })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('allows one ledger row per authorization', async () => {
    await withTestTransaction(async (db) => {
      const row = await createLibroGasto(db);
      await expect(
        createLibroGasto(db, { clienteId: row.cliente_id, autorizacionId: row.autorizacion_id }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });

  it('rejects UPDATE', async () => {
    await withTestTransaction(async (db) => {
      const row = await createLibroGasto(db);
      await expect(db.query(`UPDATE libro_gastos SET costo_real = 0 WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);
    });
  });

  it('rejects DELETE', async () => {
    await withTestTransaction(async (db) => {
      const row = await createLibroGasto(db);
      await expect(db.query(`DELETE FROM libro_gastos WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);
    });
  });

  it('rejects TRUNCATE', async () => {
    await withTestTransaction(async (db) => {
      await createLibroGasto(db);
      await expect(db.query(`TRUNCATE libro_gastos`)).rejects.toThrow(/append-only/);
    });
  });

  it('has no foreign keys, so TRUNCATE clientes CASCADE never reaches it', async () => {
    await withTestTransaction(async (db) => {
      const { rows } = await db.query(
        `SELECT 1 FROM pg_constraint WHERE contype = 'f' AND (conrelid = 'libro_gastos'::regclass OR confrelid = 'libro_gastos'::regclass)`,
      );
      expect(rows).toHaveLength(0);
    });
  });
});

describe('interruptor_global', () => {
  it('has exactly one row, enabled by default, and cannot get a second', async () => {
    await withTestTransaction(async (db) => {
      const { rows } = await db.query(`SELECT gasto_habilitado FROM interruptor_global`);
      expect(rows).toEqual([{ gasto_habilitado: true }]);
    });
    await withTestTransaction(async (db) => {
      await expect(db.query(`INSERT INTO interruptor_global (id) VALUES (false)`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(db.query(`INSERT INTO interruptor_global (id) VALUES (true)`)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });
});

describe('configuracion_gasto_cliente', () => {
  it('defaults to spending enabled and accepts no default ceiling', async () => {
    await withTestTransaction(async (db) => {
      const row = await createConfiguracionGastoCliente(db, { techoMensualDefecto: null });
      expect(row).toMatchObject({ gasto_habilitado: true, techo_mensual_defecto: null });
    });
  });

  it('rejects a negative default ceiling', async () => {
    await withTestTransaction(async (db) => {
      await expect(createConfiguracionGastoCliente(db, { techoMensualDefecto: '-1' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('has one row per client', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await createConfiguracionGastoCliente(db, { clienteId: cliente.id });
      await expect(createConfiguracionGastoCliente(db, { clienteId: cliente.id })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });
});

describe('isolation: budget tables', () => {
  it('rows of two clients stay separate by cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const a = await createCliente(db);
      const b = await createCliente(db);
      await createTope(db, { clienteId: a.id });
      await createTope(db, { clienteId: b.id, montoTecho: '99' });
      await createLibroGasto(db, { clienteId: a.id });
      const topesA = await db.query(`SELECT monto_techo FROM topes WHERE cliente_id = $1`, [a.id]);
      const ledgerB = await db.query(`SELECT 1 FROM libro_gastos WHERE cliente_id = $1`, [b.id]);
      expect(topesA.rows).toHaveLength(1);
      expect(topesA.rows[0].monto_techo).toBe('10.000000');
      expect(ledgerB.rows).toHaveLength(0);
    });
  });
});
