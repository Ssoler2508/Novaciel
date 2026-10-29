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
    for (const modelo of ['modelo-pesado-test', 'modelo-ligero-test']) {
      const priced = await db.query(`SELECT 1 FROM precios_modelos WHERE proveedor = 'fake' AND modelo = $1`, [modelo]);
      if (priced.rows.length === 0) await createPrecioModelo(db, { proveedor: 'fake', modelo, precioEntrada: '1', precioSalida: '2' });
    }
    const provider = new FakeLLMProvider({ inputTokens: 100, outputTokens: 50, models: { heavy: 'modelo-pesado-test', light: 'modelo-ligero-test' } });
    return { clienteId, provider, alerts: new FakeAlertSink() };
  }

  it('makes one call per tier through the full path and reports each model, tokens and cost', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue('{"ok": true}', '{"ok": true}');
      const report = await runLlmSmoke({ db, ...w });
      expect(report.tiers).toEqual([
        { tier: 'heavy', purpose: 'smoke_test_pesado', outcome: 'ok', reason: null, model: 'modelo-pesado-test', inputTokens: 100, outputTokens: 50, cost: 200n },
        { tier: 'light', purpose: 'smoke_test_ligero', outcome: 'ok', reason: null, model: 'modelo-ligero-test', inputTokens: 100, outputTokens: 50, cost: 200n },
      ]);
      expect(report.budget).toMatchObject({ ceiling: 1_000_000n, spent: 400n, reserved: 0n, remaining: 999_600n });
      const ledger = await db.query(`SELECT proposito, modelo, resultado FROM libro_gastos WHERE cliente_id = $1 ORDER BY id`, [w.clienteId]);
      expect(ledger.rows).toEqual([
        { proposito: 'smoke_test_pesado', modelo: 'modelo-pesado-test', resultado: 'ok' },
        { proposito: 'smoke_test_ligero', modelo: 'modelo-ligero-test', resultado: 'ok' },
      ]);
      expect(w.provider.calls.map((c) => c.tier)).toEqual(['heavy', 'light']);
    });
  });

  it('formats only, per tier, model, tokens, cost and outcome, plus the budget: no prompt, output or key-like text', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(`{"ok": true, "note": "${OUTPUT_SECRET} ${KEY_LIKE}"}`, '{"ok": true}');
      const text = formatSmokeReport(await runLlmSmoke({ db, ...w })).join(' ');
      expect(text).toContain('[heavy] model: modelo-pesado-test');
      expect(text).toContain('[light] model: modelo-ligero-test');
      expect(text).toContain('[heavy] tokens: input 100, output 50');
      expect(text).toContain('[light] cost: USD 0.000200');
      expect(text).toContain('[heavy] outcome: ok');
      expect(text).toContain('remaining USD 0.999600');
      for (const hidden of [OUTPUT_SECRET, KEY_LIKE, SMOKE_PROMPT.user, SMOKE_PROMPT.system]) expect(text).not.toContain(hidden);
    });
  });

  it('reports a schema failure of one tier after two paid attempts and still runs the other', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue('nope', `still nope ${OUTPUT_SECRET}`, '{"ok": true}');
      const report = await runLlmSmoke({ db, ...w });
      expect(report.tiers[0]).toMatchObject({ outcome: 'schema_invalido', inputTokens: 200, outputTokens: 100, cost: 400n });
      expect(report.tiers[1]).toMatchObject({ outcome: 'ok', cost: 200n });
      expect(formatSmokeReport(report).join(' ')).not.toContain(OUTPUT_SECRET);
    });
  });

  it('reports a refused budget, an unpriced tier model and a provider error without content', async () => {
    await withTestTransaction(async (db) => {
      const refused = await world(db, '0');
      refused.provider.enqueue('{"ok": true}', '{"ok": true}');
      const refusedReport = await runLlmSmoke({ db, ...refused });
      for (const t of refusedReport.tiers) expect(t).toMatchObject({ outcome: 'refused', reason: 'budget refused: techo_superado', cost: 0n });
      expect(refused.provider.calls).toHaveLength(0);

      // Only the heavy model has a price: the light call is refused before leaving, the heavy one works.
      const clienteId = asClienteId((await createCliente(db)).id);
      await createTope(db, { clienteId, montoTecho: '1' });
      await createPrecioModelo(db, { proveedor: 'fake_half', modelo: 'modelo-pesado-test', precioEntrada: '1', precioSalida: '2' });
      const half = new FakeLLMProvider({ name: 'fake_half', models: { heavy: 'modelo-pesado-test', light: 'modelo-ligero-sin-precio' } }).enqueue('{"ok": true}', '{"ok": true}');
      const halfReport = await runLlmSmoke({ db, provider: half, alerts: new FakeAlertSink(), clienteId });
      expect(halfReport.tiers[0]).toMatchObject({ outcome: 'ok' });
      expect(halfReport.tiers[1]).toMatchObject({ outcome: 'error', model: 'modelo-ligero-sin-precio' });
      expect(halfReport.tiers[1]!.reason).toMatch(/no price for fake_half\/modelo-ligero-sin-precio/);
      expect(half.calls).toHaveLength(1);

      const failing = await world(db);
      failing.provider.enqueue({ error: new ClaudeProviderError('rate_limited', 429, 'req_1') }, { error: new LLMProviderError('boom') });
      const failed = await runLlmSmoke({ db, ...failing });
      expect(failed.tiers[0]).toMatchObject({ outcome: 'error', reason: 'provider error: rate_limited (status 429)' });
      expect(failed.tiers[1]!.reason).toBe('unexpected error: LLMProviderError');
    });
  });
});
