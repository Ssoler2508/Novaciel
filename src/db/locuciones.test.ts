import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  createAutorizacionGasto,
  createCliente,
  createGuion,
  createLocucion,
  createProduccion,
  createProduccionLocucion,
  createTope,
} from '../../tests/utils/factories/index.js';
import { authorize, settle } from '../modules/presupuesto/presupuestoService.js';
import { usdToMicro } from '../modules/presupuesto/money.js';
import { asClienteId } from '../modules/shared/clienteId.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const SISTEMA = { tipo: 'sistema' } as const;

describe('libro_gastos: the unit', () => {
  it('records tokens by default and characters when settle says so', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      await createTope(db, { clienteId, montoTecho: '10' });
      const request = { estimatedCost: usdToMicro('0.5'), purpose: 'voz_en_off', provider: 'fake_voice', model: 'fake-tts-model' };

      const tokens = await authorize(db, clienteId, request, SISTEMA);
      await settle(db, tokens, { actualCost: usdToMicro('0.1'), inputUnits: 100, outputUnits: 20, outcome: 'ok' }, SISTEMA);
      const chars = await authorize(db, clienteId, request, SISTEMA);
      await settle(db, chars, { actualCost: usdToMicro('0.08'), inputUnits: 1000, outputUnits: 0, unit: 'caracteres', outcome: 'ok' }, SISTEMA);

      const { rows } = await db.query('SELECT autorizacion_id, unidad, unidades_entrada, unidades_salida FROM libro_gastos WHERE cliente_id = $1', [clienteId]);
      const byAuth = new Map(rows.map((r) => [r.autorizacion_id, r]));
      expect(byAuth.get(tokens.id)).toMatchObject({ unidad: 'tokens', unidades_entrada: '100' });
      expect(byAuth.get(chars.id)).toMatchObject({ unidad: 'caracteres', unidades_entrada: '1000', unidades_salida: '0' });
      const audit = await db.query(`SELECT datos_despues FROM auditoria WHERE tabla = 'autorizaciones_gasto' AND fila_id = $1 AND accion = 'liquidar'`, [chars.id]);
      expect(audit.rows[0].datos_despues).toMatchObject({ unidad: 'caracteres' });
    });
  });

  it('refuses an unknown unit and stays append-only', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = (await createCliente(db)).id;
      const auth = await createAutorizacionGasto(db, { clienteId, estado: 'liquidada' });
      await db.query('SAVEPOINT bad');
      await expect(
        db.query(
          `INSERT INTO libro_gastos (cliente_id, autorizacion_id, periodo, proveedor, modelo, unidades_entrada, unidades_salida, costo_real, proposito, resultado, unidad)
           VALUES ($1, $2, date_trunc('month', now())::date, 'p', 'm', 1, 0, 0, 'x', 'ok', 'palabras')`,
          [clienteId, auth.id],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await db.query('ROLLBACK TO SAVEPOINT bad');
    });
  });
});

describe('locuciones', () => {
  it('stores a voice-over of a scene of the brief', async () => {
    await withTestTransaction(async (db) => {
      const row = await createLocucion(db, { escena: 2, duracionMs: 3200, caracteres: 40, costoReal: '0.003200' });
      expect(row).toMatchObject({ escena: 2, duracion_ms: 3200, caracteres: 40, costo_real: '0.003200', proveedor: 'fake_voice' });
      expect(row.clave_cache).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('is append-only: UPDATE and DELETE are refused', async () => {
    await withTestTransaction(async (db) => {
      const row = await createLocucion(db);
      await db.query('SAVEPOINT u');
      await expect(db.query('UPDATE locuciones SET duracion_ms = 5 WHERE id = $1', [row.id])).rejects.toThrow(/append-only/);
      await db.query('ROLLBACK TO SAVEPOINT u');
      await db.query('SAVEPOINT d');
      await expect(db.query('DELETE FROM locuciones WHERE id = $1', [row.id])).rejects.toThrow(/append-only/);
      await db.query('ROLLBACK TO SAVEPOINT d');
    });
  });

  it('is append-only: TRUNCATE is refused outside the test cleanup flag', async () => {
    await withTestTransaction(async (db) => {
      await db.query('SAVEPOINT t');
      await expect(db.query('TRUNCATE locuciones CASCADE')).rejects.toThrow(/append-only/);
      await db.query('ROLLBACK TO SAVEPOINT t');
      await db.query('SAVEPOINT t2');
      await expect(db.query('TRUNCATE producciones_locuciones CASCADE')).rejects.toThrow(/append-only/);
      await db.query('ROLLBACK TO SAVEPOINT t2');
    });
  });

  it('the same cache key is unique per client: the second insert is refused', async () => {
    await withTestTransaction(async (db) => {
      const first = await createLocucion(db);
      await db.query('SAVEPOINT dup');
      // The storage key derives from the cache key, so either constraint fires: both mean "paid once".
      await expect(createLocucion(db, { clienteId: first.cliente_id, guionId: first.guion_id, escena: 2, claveCache: first.clave_cache })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
      await db.query('ROLLBACK TO SAVEPOINT dup');
    });
  });

  it('the same cache key is a different row for another client', async () => {
    await withTestTransaction(async (db) => {
      const a = await createLocucion(db);
      // A second client with its own brief and the SAME key is accepted.
      const b = await createLocucion(db, { claveCache: a.clave_cache });
      expect(b.cliente_id).not.toBe(a.cliente_id);
      expect(b.clave_cache).toBe(a.clave_cache);
    });
  });

  it('refuses malformed rows (key not 64 hex, zero duration, zero characters, empty voice id)', async () => {
    await withTestTransaction(async (db) => {
      const cases: [string, Parameters<typeof createLocucion>[1]][] = [
        ['short_key', { claveCache: 'abc' }],
        ['upper_key', { claveCache: 'A'.repeat(64) }],
        ['zero_duration', { duracionMs: 0 }],
        ['zero_chars', { caracteres: 0 }],
        ['scene_zero', { escena: 0 }],
      ];
      for (const [name, overrides] of cases) {
        await db.query(`SAVEPOINT ${name}`);
        await expect(createLocucion(db, overrides), name).rejects.toMatchObject({ code: CHECK_VIOLATION });
        await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
      }
    });
  });

  it("a voice-over needs a brief of the same client (composite FK)", async () => {
    await withTestTransaction(async (db) => {
      const a = await createGuion(db);
      const other = await createCliente(db);
      await db.query('SAVEPOINT fk');
      await expect(createLocucion(db, { clienteId: other.id, guionId: a.id })).rejects.toMatchObject({ code: FK_VIOLATION });
      await db.query('ROLLBACK TO SAVEPOINT fk');
    });
  });
});

describe('producciones_locuciones', () => {
  it('links a production to the voice-over of a scene, once per scene, and is append-only', async () => {
    await withTestTransaction(async (db) => {
      const produccion = await createProduccion(db);
      const guion = (await db.query<{ id: string }>('SELECT id FROM guiones WHERE id = $1', [produccion.guion_id])).rows[0]!;
      const locucion = await createLocucion(db, { clienteId: produccion.cliente_id, guionId: guion.id });
      const link = await createProduccionLocucion(db, { produccionId: produccion.id, clienteId: produccion.cliente_id, locucionId: locucion.id, escena: 1 });
      expect(link).toMatchObject({ produccion_id: produccion.id, locucion_id: locucion.id, escena: 1 });

      await db.query('SAVEPOINT dup');
      await expect(createProduccionLocucion(db, { produccionId: produccion.id, clienteId: produccion.cliente_id, locucionId: locucion.id, escena: 1 })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
      await db.query('ROLLBACK TO SAVEPOINT dup');
      await db.query('SAVEPOINT upd');
      await expect(db.query('UPDATE producciones_locuciones SET escena = 2 WHERE produccion_id = $1', [produccion.id])).rejects.toThrow(/append-only/);
      await db.query('ROLLBACK TO SAVEPOINT upd');
      await db.query('SAVEPOINT del');
      await expect(db.query('DELETE FROM producciones_locuciones WHERE produccion_id = $1', [produccion.id])).rejects.toThrow(/append-only/);
      await db.query('ROLLBACK TO SAVEPOINT del');
    });
  });

  it("cannot link another client's voice-over to a production (composite FK)", async () => {
    await withTestTransaction(async (db) => {
      const produccion = await createProduccion(db);
      const foreign = await createLocucion(db);
      await db.query('SAVEPOINT fk');
      await expect(
        createProduccionLocucion(db, { produccionId: produccion.id, clienteId: produccion.cliente_id, locucionId: foreign.id }),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
      await db.query('ROLLBACK TO SAVEPOINT fk');
    });
  });
});
