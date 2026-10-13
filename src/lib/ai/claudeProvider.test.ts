import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { createCliente, createPrecioModelo, createTope } from '../../../tests/utils/factories/index.js';
import { loadConfig } from '../../config/index.js';
import { generateStructured } from '../../modules/ai/generateStructured.js';
import { asClienteId } from '../../modules/shared/clienteId.js';
import { createLogger } from '../logger/index.js';
import { FakeAlertSink } from './alerts.js';
import { ClaudeProvider, ClaudeProviderError, SDK_MAX_RETRIES, type ClaudeErrorKind } from './claudeProvider.js';
import { createLLMProvider } from './index.js';
import { LLMProviderError } from './types.js';

// A fake HTTP layer is passed to the SDK: no test here touches the network.
const KEY = 'sk-fake-test-key-DO-NOT-USE-123456';
const MODEL = 'fake-claude-model';
const PROMPT_SECRET = 'PROMPT-SECRET-TEXT-4711';
const BODY_SECRET = 'RESPONSE-BODY-SECRET-5512';

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function messageBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: '{"title":"ok","score":3}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 40 },
    ...overrides,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'retry-after-ms': '1', ...headers },
  });
}

/** A fetch that answers from a script (a Response, or a function for errors) and records requests. */
function fakeFetch(...script: (Response | ((init: RequestInit) => Promise<Response>))[]) {
  const seen: Seen[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const next = script.shift();
    if (!next) throw new Error('fake fetch script exhausted');
    return typeof next === 'function' ? next(init ?? {}) : next;
  };
  return { fetch: impl as typeof fetch, seen };
}

function provider(f: ReturnType<typeof fakeFetch>, extra: Partial<ConstructorParameters<typeof ClaudeProvider>[0]> = {}) {
  return new ClaudeProvider({ apiKey: KEY, defaultModel: MODEL, timeoutMs: 5000, maxRetries: 0, fetch: f.fetch, ...extra });
}

const request = {
  system: 'Return JSON.',
  messages: [{ role: 'user' as const, content: `Write about ${PROMPT_SECRET}.` }],
  maxOutputTokens: 321,
};

afterEach(() => vi.unstubAllEnvs());

async function failureOf(p: ClaudeProvider): Promise<ClaudeProviderError> {
  const error = await p.generate(request).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ClaudeProviderError);
  return error as ClaudeProviderError;
}

describe('ClaudeProvider: success', () => {
  it('maps text, usage, model and stop reason', async () => {
    const f = fakeFetch(
      json(200, messageBody({
        content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 7 },
      })),
    );
    await expect(provider(f).generate(request)).resolves.toEqual({
      text: 'Hello world',
      inputTokens: 10,
      outputTokens: 7,
      model: MODEL,
      stopReason: 'max_tokens',
    });
  });

  it('counts cached input tokens too, and ignores non-text blocks', async () => {
    const f = fakeFetch(
      json(200, messageBody({
        content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }, { type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 2 },
      })),
    );
    await expect(provider(f).generate(request)).resolves.toMatchObject({ text: 'ok', inputTokens: 15, outputTokens: 5 });
  });

  it('sends the configured model and max_tokens, the system prompt and the messages', async () => {
    const f = fakeFetch(json(200, messageBody()), json(200, messageBody()));
    const p = provider(f);
    await p.generate(request);
    await p.generate({ ...request, model: 'other-fake-model' });
    expect(f.seen[0]!.body).toEqual({
      model: MODEL,
      max_tokens: 321,
      system: 'Return JSON.',
      messages: [{ role: 'user', content: request.messages[0]!.content }],
    });
    expect(f.seen[1]!.body.model).toBe('other-fake-model');
  });

  it('uses only our key and the fixed Anthropic URL, even if the SDK environment variables are set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-decoy-from-claude-code');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'decoy-auth-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.example.test');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    const f = fakeFetch(json(200, messageBody()));
    await new ClaudeProvider({ apiKey: KEY, defaultModel: MODEL, timeoutMs: 5000, fetch: f.fetch }).generate(request);
    const seen = f.seen[0]!;
    expect(seen.url.startsWith('https://api.anthropic.com/')).toBe(true);
    expect(seen.headers.get('x-api-key')).toBe(KEY);
    expect(seen.headers.get('authorization')).toBeNull();
    expect(JSON.stringify([...seen.headers.entries()])).not.toContain('decoy');
  });
});

describe('ClaudeProvider: errors', () => {
  it.each<[number, ClaudeErrorKind]>([
    [400, 'bad_request'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'bad_request'],
    [413, 'bad_request'],
    [422, 'bad_request'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'server'],
    [529, 'server'],
  ])('maps HTTP %i to %s, with no body content in the error', async (status, kind) => {
    const f = fakeFetch(
      json(status, { type: 'error', error: { type: 'some_error', message: `echo ${BODY_SECRET} ${PROMPT_SECRET} ${KEY}` } }, { 'request-id': 'req_abc' }),
    );
    const error = await failureOf(provider(f));
    expect(error).toBeInstanceOf(LLMProviderError);
    expect(error).toMatchObject({ kind, status, requestId: 'req_abc', usage: undefined });
    const shown = [error.message, String(error), JSON.stringify(error), inspect(error, { depth: 5 })].join('\n');
    for (const secret of [BODY_SECRET, PROMPT_SECRET, KEY]) expect(shown).not.toContain(secret);
  });

  it('maps a timeout', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const f = fakeFetch(hang);
    const error = await failureOf(provider(f, { timeoutMs: 30 }));
    expect(error.kind).toBe('timeout');
    expect(error.message).not.toContain(KEY);
  });

  it('maps a network failure to server and does not forward its message', async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError(`connect failed ${KEY} ${PROMPT_SECRET}`)));
    const error = await failureOf(provider(f));
    expect(error.kind).toBe('server');
    expect(`${error.message} ${inspect(error)}`).not.toContain(PROMPT_SECRET);
    expect(error.message).not.toContain(KEY);
  });

  it('uses exactly one SDK retry by default for transient failures', () => {
    expect(SDK_MAX_RETRIES).toBe(1);
  });

  it('retries a transient 5xx once, then succeeds', async () => {
    const f = fakeFetch(json(500, { type: 'error', error: { type: 'api_error', message: 'x' } }), json(200, messageBody()));
    await expect(provider(f, { maxRetries: SDK_MAX_RETRIES }).generate(request)).resolves.toMatchObject({ text: '{"title":"ok","score":3}' });
    expect(f.seen).toHaveLength(2);
  });

  it('gives up after the single retry', async () => {
    const down = () => json(500, { type: 'error', error: { type: 'api_error', message: 'x' } });
    const f = fakeFetch(down(), down(), down());
    const error = await failureOf(provider(f, { maxRetries: SDK_MAX_RETRIES }));
    expect(error.kind).toBe('server');
    expect(f.seen).toHaveLength(2);
  });

  it('does not retry a bad request', async () => {
    const f = fakeFetch(json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'x' } }), json(200, messageBody()));
    expect((await failureOf(provider(f, { maxRetries: SDK_MAX_RETRIES }))).kind).toBe('bad_request');
    expect(f.seen).toHaveLength(1);
  });
});

describe('ClaudeProvider with generateStructured', () => {
  it('runs the full path over the fake HTTP layer and never logs the key or the prompt', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      await createTope(db, { clienteId });
      await createPrecioModelo(db, { proveedor: 'claude', modelo: MODEL, precioEntrada: '1', precioSalida: '2' });
      const lines: string[] = [];
      const logger = createLogger('debug', { write: (l: string) => void lines.push(l) });
      const schema = z.object({ title: z.string(), score: z.number() });

      const ok = fakeFetch(json(200, messageBody()));
      const result = await generateStructured(
        { db, provider: provider(ok), alerts: new FakeAlertSink(), logger },
        { clienteId, purpose: 'test_purpose', schema, prompt: { system: 's', user: `u ${PROMPT_SECRET}` }, maxOutputTokens: 100, actor: { tipo: 'sistema' } },
      );
      // 120 * 1.00/M + 40 * 2.00/M = 200 micro-USD.
      expect(result).toMatchObject({ data: { title: 'ok', score: 3 }, cost: 200n });
      const ledger = await db.query('SELECT proveedor, modelo, costo_real::text AS costo, resultado FROM libro_gastos WHERE cliente_id = $1', [clienteId]);
      expect(ledger.rows).toEqual([{ proveedor: 'claude', modelo: MODEL, costo: '0.000200', resultado: 'ok' }]);

      // A failing call releases the reservation and stays clean in the logs.
      const down = fakeFetch(json(500, { type: 'error', error: { type: 'api_error', message: `${BODY_SECRET}` } }));
      await expect(
        generateStructured(
          { db, provider: provider(down), alerts: new FakeAlertSink(), logger },
          { clienteId, purpose: 'test_purpose', schema, prompt: { system: 's', user: `u ${PROMPT_SECRET}` }, maxOutputTokens: 100, actor: { tipo: 'sistema' } },
        ),
      ).rejects.toBeInstanceOf(ClaudeProviderError);
      const states = await db.query(`SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1 ORDER BY creado_en, id`, [clienteId]);
      expect(states.rows.map((r) => r.estado).sort()).toEqual(['liberada', 'liquidada']);

      const logText = lines.join('');
      for (const secret of [KEY, PROMPT_SECRET, BODY_SECRET]) expect(logText).not.toContain(secret);
    });
  });
});

describe('createLLMProvider and config', () => {
  const base = {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    LOG_LEVEL: 'info',
    LOCAL_STORAGE_SIGNING_SECRET: 'x'.repeat(32),
    SECRETS_KEYS: `1:${Buffer.alloc(32, 1).toString('base64')}`,
    SECRETS_ACTIVE_KEY_VERSION: '1',
  };
  const claude = { ...base, LLM_PROVIDER: 'claude', LLM_MODEL: MODEL, NOVACIEL_ANTHROPIC_API_KEY: KEY };

  it('builds a ClaudeProvider from config', () => {
    const cfg = loadConfig(claude);
    const p = createLLMProvider(cfg.llm);
    expect(p).toBeInstanceOf(ClaudeProvider);
    expect(p).toMatchObject({ name: 'claude', defaultModel: MODEL });
  });

  it('requires the key only with the claude provider, and the message never prints a key', () => {
    expect(() => loadConfig({ ...claude, NOVACIEL_ANTHROPIC_API_KEY: undefined })).toThrow(/NOVACIEL_ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ ...claude, NOVACIEL_ANTHROPIC_API_KEY: '' })).toThrow(/NOVACIEL_ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'fake' })).not.toThrow();
    expect(() => loadConfig(base)).not.toThrow();
    try {
      loadConfig({ ...claude, LLM_MODEL: undefined });
    } catch (error) {
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it('ignores ANTHROPIC_API_KEY entirely', () => {
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'claude', LLM_MODEL: MODEL, ANTHROPIC_API_KEY: KEY })).toThrow(/NOVACIEL_ANTHROPIC_API_KEY/);
    const cfg = loadConfig({ ...claude, ANTHROPIC_API_KEY: 'sk-decoy' });
    expect(cfg.llm.apiKey?.reveal()).toBe(KEY);
  });

  it('keeps the key out of JSON, inspect and logs of the config', () => {
    const cfg = loadConfig(claude);
    const lines: string[] = [];
    createLogger('info', { write: (l: string) => void lines.push(l) }).info({ cfg }, 'config');
    for (const shown of [JSON.stringify(cfg), inspect(cfg, { depth: 6 }), String(cfg.llm.apiKey), lines.join('')]) {
      expect(shown).not.toContain(KEY);
    }
    expect(Object.keys(cfg)).not.toContain('NOVACIEL_ANTHROPIC_API_KEY');
  });

  it('LLM_TIMEOUT_MS defaults to 60000 and is bounded', () => {
    expect(loadConfig(base).llm.timeoutMs).toBe(60_000);
    expect(loadConfig({ ...base, LLM_TIMEOUT_MS: '15000' }).llm.timeoutMs).toBe(15_000);
    for (const bad of ['0', '999', '600001', 'abc', '1.5']) {
      expect(() => loadConfig({ ...base, LLM_TIMEOUT_MS: bad })).toThrow(/LLM_TIMEOUT_MS/);
    }
  });
});
