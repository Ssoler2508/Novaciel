import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createCliente, createConfiguracionGastoCliente, createPrecioModelo, createTope } from '../../tests/utils/factories/index.js';
import { FakeAlertSink, FakeLLMProvider, LLMProviderError } from '../lib/ai/index.js';
import { ClaudeProviderError } from '../lib/ai/claudeProvider.js';
import { asClienteId } from '../modules/shared/clienteId.js';
import { parseLlmSmokeArgs } from './llmSmokeArgs.js';
import { formatSmokeReport, runLlmSmoke, SMOKE_PROMPT } from './llmSmokeCore.js';
import { assertLlmSmokeAllowed, confirmLlmSmokeDatabase } from './llmSmokeGuard.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const OUTPUT_SECRET = 'OUTPUT-SECRET-TEXT-9283';
const KEY_LIKE = 'sk-fake-test-key-DO-NOT-USE-123456';

describe('parseLlmSmokeArgs', () => {
  it('accepts --cliente in both syntaxes', () => {
    expect(parseLlmSmokeArgs(['--cliente', ID]).clienteId).toBe(ID);
    expect(parseLlmSmokeArgs([`--cliente=${ID}`]).clienteId).toBe(ID);
  });

  it('rejects missing, repeated, unknown and malformed options without echoing values', () => {
    for (const argv of [[], ['--cliente'], ['--cliente', '--other'], ['--cliente', ID, '--cliente', ID], ['--force', 'x'], ['positional'], ['--cliente', 'not-a-uuid-secret-123']]) {
      let message = '';
      try {
        parseLlmSmokeArgs(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('not-a-uuid-secret-123');
    }
  });
});

describe('assertLlmSmokeAllowed', () => {
  const url = (name: string) => `postgresql://fakeuser:fakepassword@localhost:5432/${name}`;
  const ok = { nodeEnv: 'development', databaseUrl: url('fake_dev'), llmProvider: 'claude', hasApiKey: true };

  it('accepts a development database with the claude provider and a key', () => {
    expect(assertLlmSmokeAllowed(ok)).toBe('fake_dev');
  });

  it('refuses production, _test databases (also percent-encoded) and names the database', () => {
    expect(() => assertLlmSmokeAllowed({ ...ok, nodeEnv: 'production' })).toThrow(/production/);
    expect(() => assertLlmSmokeAllowed({ ...ok, databaseUrl: url('fake_test') })).toThrow(/"fake_test"/);
    expect(() => assertLlmSmokeAllowed({ ...ok, databaseUrl: url('fake%5Ftest') })).toThrow(/"fake_test"/);
  });

  it('requires LLM_PROVIDER=claude and a key, and never echoes URLs', () => {
    expect(() => assertLlmSmokeAllowed({ ...ok, llmProvider: 'fake' })).toThrow(/LLM_PROVIDER=claude/);
    expect(() => assertLlmSmokeAllowed({ ...ok, hasApiKey: false })).toThrow(/NOVACIEL_ANTHROPIC_API_KEY/);
    let message = '';
    try {
      assertLlmSmokeAllowed({ ...ok, databaseUrl: 'not a url, secret-token' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not a valid URL/);
    expect(message).not.toContain('secret-token');
  });

  it("refuses when the server's own database name ends in _test", async () => {
    const fakeDb = (name: string) => ({ query: async () => ({ rows: [{ name }] }) }) as never;
    await expect(confirmLlmSmokeDatabase(fakeDb('fake_test'))).rejects.toThrow(/"fake_test"/);
    await expect(confirmLlmSmokeDatabase(fakeDb('fake_dev'))).resolves.toBe('fake_dev');
  });
});

describe('runLlmSmoke (fake provider, no network)', () => {
  async function world(db: Parameters<Parameters<typeof withTestTransaction>[0]>[0], ceiling = '1') {
    const clienteId = asClienteId((await createCliente(db)).id);
    await createTope(db, { clienteId, montoTecho: ceiling });
    const priced = await db.query(`SELECT 1 FROM precios_modelos WHERE proveedor = 'fake' AND modelo = 'fake-model'`);
    if (priced.rows.length === 0) {
      await createPrecioModelo(db, { proveedor: 'fake', modelo: 'fake-model', precioEntrada: '1', precioSalida: '2' });
    }
    return { clienteId, provider: new FakeLLMProvider({ inputTokens: 100, outputTokens: 50 }), alerts: new FakeAlertSink() };
  }

  it('runs the full path, writes one ledger row and reports exact numbers and the remaining budget', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue('{"ok": true}');
      const report = await runLlmSmoke({ db, ...w });
      expect(report).toMatchObject({ outcome: 'ok', reason: null, model: 'fake-model', inputTokens: 100, outputTokens: 50, cost: 200n });
      expect(report.budget).toMatchObject({ ceiling: 1_000_000n, spent: 200n, reserved: 0n, remaining: 999_800n });
      const ledger = await db.query(`SELECT proposito, resultado FROM libro_gastos WHERE cliente_id = $1`, [w.clienteId]);
      expect(ledger.rows).toEqual([{ proposito: 'smoke_test', resultado: 'ok' }]);
      expect(w.provider.calls).toHaveLength(1);
    });
  });

  it('formats only model, tokens, cost, outcome and budget: no prompt, output or key-like text', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(`{"ok": true, "note": "${OUTPUT_SECRET} ${KEY_LIKE}"}`);
      const text = formatSmokeReport(await runLlmSmoke({ db, ...w })).join('\n');
      expect(text).toContain('model: fake-model');
      expect(text).toContain('tokens: input 100, output 50');
      expect(text).toContain('cost: USD 0.000200');
      expect(text).toContain('outcome: ok');
      expect(text).toContain('remaining USD 0.999800');
      for (const hidden of [OUTPUT_SECRET, KEY_LIKE, SMOKE_PROMPT.user, SMOKE_PROMPT.system]) expect(text).not.toContain(hidden);
    });
  });

  it('reports a schema failure after two paid attempts', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue('nope', `still nope ${OUTPUT_SECRET}`);
      const report = await runLlmSmoke({ db, ...w });
      expect(report).toMatchObject({ outcome: 'schema_invalido', inputTokens: 200, outputTokens: 100, cost: 400n });
      expect(formatSmokeReport(report).join('\n')).not.toContain(OUTPUT_SECRET);
    });
  });

  it('reports a refused budget, an unpriced model and a provider error without content', async () => {
    await withTestTransaction(async (db) => {
      const refused = await world(db, '0');
      refused.provider.enqueue('{"ok": true}');
      expect(await runLlmSmoke({ db, ...refused })).toMatchObject({ outcome: 'refused', reason: 'budget refused: techo_superado', cost: 0n });
      expect(refused.provider.calls).toHaveLength(0);

      const clienteId = asClienteId((await createCliente(db)).id);
      await createConfiguracionGastoCliente(db, { clienteId, techoMensualDefecto: '1' });
      const unpriced = new FakeLLMProvider({ name: 'fake_unpriced' }).enqueue('{"ok": true}');
      const report = await runLlmSmoke({ db, provider: unpriced, alerts: new FakeAlertSink(), clienteId });
      expect(report.outcome).toBe('error');
      expect(report.reason).toMatch(/no price for fake_unpriced\/fake-model/);
      expect(unpriced.calls).toHaveLength(0);

      const failing = await world(db);
      failing.provider.enqueue({ error: new ClaudeProviderError('rate_limited', 429, 'req_1') });
      expect(await runLlmSmoke({ db, ...failing })).toMatchObject({ outcome: 'error', reason: 'provider error: rate_limited (status 429)' });
      failing.provider.enqueue({ error: new LLMProviderError('boom') });
      expect((await runLlmSmoke({ db, ...failing })).reason).toBe('unexpected error: LLMProviderError');
    });
  });
});
