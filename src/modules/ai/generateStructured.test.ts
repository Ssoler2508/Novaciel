import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { createCliente, createConfiguracionGastoCliente, createPrecioModelo, createTope } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeAlertSink, FakeLLMProvider, LLMProviderError } from '../../lib/ai/index.js';
import { createLogger } from '../../lib/logger/index.js';
import { PriceNotFoundError } from '../precios/preciosRepository.js';
import { BudgetRefusedError, getSpendSummary } from '../presupuesto/presupuestoService.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { generateStructured, RETRY_NOTE, SchemaValidationError } from './generateStructured.js';

const SISTEMA = { tipo: 'sistema' } as const;
const schema = z.object({ title: z.string(), score: z.number() });
const VALID = JSON.stringify({ title: 'ok', score: 3 });
const PROMPT_SECRET = 'PROMPT-SECRET-TEXT-4711';
const OUTPUT_SECRET = 'OUTPUT-SECRET-TEXT-9283';
const prompt = { system: 'Return JSON.', user: `Write a title about ${PROMPT_SECRET}.` };

function capturedLogger() {
  const lines: string[] = [];
  return { log: createLogger('debug', { write: (l: string) => void lines.push(l) }), text: () => lines.join('') };
}

// Fake prices: 1.00 USD per million input tokens, 2.00 per million output tokens.
async function world(db: Db, ceiling = '10') {
  const clienteId = asClienteId((await createCliente(db)).id);
  await createTope(db, { clienteId, montoTecho: ceiling });
  const priced = await db.query(`SELECT 1 FROM precios_modelos WHERE proveedor = 'fake' AND modelo = 'fake-model'`);
  if (priced.rows.length === 0) {
    await createPrecioModelo(db, { proveedor: 'fake', modelo: 'fake-model', precioEntrada: '1', precioSalida: '2' });
  }
  const provider = new FakeLLMProvider({ inputTokens: 100, outputTokens: 50 });
  const alerts = new FakeAlertSink();
  const logs = capturedLogger();
  const run = (overrides: Partial<{ clienteId: ClienteId }> = {}) =>
    generateStructured(
      { db, provider, alerts, logger: logs.log },
      { clienteId: overrides.clienteId ?? clienteId, purpose: 'test_purpose', schema, prompt, maxOutputTokens: 1000, actor: SISTEMA },
    );
  return { clienteId, provider, alerts, logs, run };
}

async function ledger(db: Db, clienteId: string) {
  return (await db.query('SELECT resultado, costo_real::text AS costo, unidades_entrada, unidades_salida, proposito, modelo, proveedor FROM libro_gastos WHERE cliente_id = $1 ORDER BY id', [clienteId])).rows;
}

describe('generateStructured', () => {
  it('returns valid output, writes one ledger row with the exact cost, and does not alert', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(VALID);
      const result = await w.run();
      expect(result).toMatchObject({ data: { title: 'ok', score: 3 }, attempts: 1, inputTokens: 100, outputTokens: 50, cost: 200n });
      // 100 * 1.00/M + 50 * 2.00/M = 0.000200 USD.
      expect(await ledger(db, w.clienteId)).toEqual([
        { resultado: 'ok', costo: '0.000200', unidades_entrada: '100', unidades_salida: '50', proposito: 'test_purpose', modelo: 'fake-model', proveedor: 'fake' },
      ]);
      expect(w.provider.calls).toHaveLength(1);
      expect(w.provider.calls[0]).toMatchObject({ model: 'fake-model', maxOutputTokens: 1000, messages: [{ role: 'user', content: prompt.user }] });
      expect(w.alerts.alerts).toEqual([]);
      const summary = await getSpendSummary(db, w.clienteId);
      expect(summary).toMatchObject({ spent: 200n, reserved: 0n });
    });
  });

  it('accepts JSON inside a code fence', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue('```json\n' + VALID + '\n```');
      await expect(w.run()).resolves.toMatchObject({ data: { title: 'ok' } });
    });
  });

  it('invalid then valid: exactly 2 paid calls, 2 authorizations, 2 ledger rows, no alert', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue('not json at all', VALID);
      const result = await w.run();
      expect(result).toMatchObject({ attempts: 2, inputTokens: 200, outputTokens: 100, cost: 400n });
      expect((await ledger(db, w.clienteId)).map((r) => r.resultado)).toEqual(['schema_invalido', 'ok']);
      const auths = await db.query(`SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1`, [w.clienteId]);
      expect(auths.rows).toEqual([{ estado: 'liquidada' }, { estado: 'liquidada' }]);
      expect(w.provider.calls).toHaveLength(2);
      expect(w.provider.calls[1]!.messages[0]!.content).toBe(`${prompt.user}\n\n${RETRY_NOTE}`);
      expect(w.alerts.alerts).toEqual([]);
    });
  });

  it('a schema mismatch counts as invalid output too', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(JSON.stringify({ title: 1 }), VALID);
      await expect(w.run()).resolves.toMatchObject({ attempts: 2 });
    });
  });

  it('invalid twice: 2 ledger rows, one alert with metadata only, and SchemaValidationError', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(`{"wrong": "${OUTPUT_SECRET}"}`, `nope ${OUTPUT_SECRET}`);
      const error = await w.run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as Error).message).not.toContain(OUTPUT_SECRET);
      expect((await ledger(db, w.clienteId)).map((r) => r.resultado)).toEqual(['schema_invalido', 'schema_invalido']);
      expect(w.provider.calls).toHaveLength(2);
      expect(w.alerts.alerts).toEqual([
        { code: 'llm_schema_invalid', clienteId: w.clienteId, purpose: 'test_purpose', provider: 'fake', model: 'fake-model', attempts: 2 },
      ]);
    });
  });

  it('a refused budget means 0 provider calls (ceiling, client switch, global switch)', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, '0');
      w.provider.enqueue(VALID);
      await expect(w.run()).rejects.toMatchObject({ reason: 'techo_superado' });

      const other = await world(db);
      await createConfiguracionGastoCliente(db, { clienteId: other.clienteId, gastoHabilitado: false });
      other.provider.enqueue(VALID);
      await expect(other.run()).rejects.toBeInstanceOf(BudgetRefusedError);

      await db.query('UPDATE interruptor_global SET gasto_habilitado = false');
      const third = await world(db);
      third.provider.enqueue(VALID);
      await expect(third.run()).rejects.toMatchObject({ reason: 'interruptor_global' });

      for (const p of [w.provider, other.provider, third.provider]) expect(p.calls).toHaveLength(0);
      expect(await ledger(db, w.clienteId)).toEqual([]);
    });
  });

  it('an unpriced model never reaches the provider or the budget', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      await createTope(db, { clienteId });
      const provider = new FakeLLMProvider({ name: 'fake_unpriced' }).enqueue(VALID);
      await expect(
        generateStructured(
          { db, provider, alerts: new FakeAlertSink() },
          { clienteId, purpose: 'p', schema, prompt, maxOutputTokens: 10, actor: SISTEMA },
        ),
      ).rejects.toThrow(PriceNotFoundError);
      expect(provider.calls).toHaveLength(0);
      expect((await db.query('SELECT 1 FROM autorizaciones_gasto WHERE cliente_id = $1', [clienteId])).rows).toHaveLength(0);
    });
  });

  it('a provider error without usage releases the reservation and rethrows', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, '10');
      const failure = new LLMProviderError('upstream unavailable');
      w.provider.enqueue({ error: failure });
      await expect(w.run()).rejects.toBe(failure);
      expect(await ledger(db, w.clienteId)).toEqual([]);
      expect(await getSpendSummary(db, w.clienteId)).toMatchObject({ spent: 0n, reserved: 0n });
      const auths = await db.query(`SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1`, [w.clienteId]);
      expect(auths.rows).toEqual([{ estado: 'liberada' }]);
      expect(w.provider.calls).toHaveLength(1);
    });
  });

  it('a provider error that reports usage is settled with outcome "error" and its real cost', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue({ error: new LLMProviderError('cut off', { inputTokens: 1000, outputTokens: 500 }) });
      await expect(w.run()).rejects.toBeInstanceOf(LLMProviderError);
      expect(await ledger(db, w.clienteId)).toMatchObject([{ resultado: 'error', costo: '0.002000', unidades_entrada: '1000', unidades_salida: '500' }]);
    });
  });

  it('a provider error is not retried', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue({ error: new Error('boom' + OUTPUT_SECRET.length) }, VALID);
      await expect(w.run()).rejects.toThrow('boom');
      expect(w.provider.calls).toHaveLength(1);
    });
  });

  it('logs contain metadata only, never the prompt or the output', async () => {
    await withTestTransaction(async (db) => {
      const ok = await world(db);
      ok.provider.enqueue(JSON.stringify({ title: OUTPUT_SECRET, score: 1 }));
      await ok.run();

      const bad = await world(db);
      bad.provider.enqueue(`x ${OUTPUT_SECRET}`, `y ${OUTPUT_SECRET}`);
      await bad.run().catch(() => undefined);

      const failing = await world(db);
      failing.provider.enqueue({ error: new LLMProviderError('failed') });
      await failing.run().catch(() => undefined);

      for (const w of [ok, bad, failing]) {
        const text = w.logs.text();
        expect(text).not.toContain(PROMPT_SECRET);
        expect(text).not.toContain(OUTPUT_SECRET);
        expect(text).toContain('test_purpose');
      }
      expect(JSON.stringify(bad.alerts.alerts)).not.toContain(OUTPUT_SECRET);
      const audit = await db.query('SELECT datos_antes, datos_despues FROM auditoria');
      expect(JSON.stringify(audit.rows)).not.toContain(PROMPT_SECRET);
      expect(JSON.stringify(audit.rows)).not.toContain(OUTPUT_SECRET);
    });
  });

  it("client A's call never spends B's budget", async () => {
    await withTestTransaction(async (db) => {
      const a = await world(db);
      const b = await world(db);
      a.provider.enqueue(VALID);
      await a.run();
      expect(await ledger(db, b.clienteId)).toEqual([]);
      expect(await getSpendSummary(db, b.clienteId)).toMatchObject({ spent: 0n });
    });
  });
});
