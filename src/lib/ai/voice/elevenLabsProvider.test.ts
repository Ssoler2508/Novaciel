import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ELEVENLABS_BASE_URL, ELEVENLABS_FORMAT, ElevenLabsProvider, voiceErrorKind } from './elevenLabsProvider.js';
import { VoiceProviderError, type SynthesisRequest, type VoiceErrorKind } from './types.js';

// No network: every call goes through a mocked fetch, and the GLOBAL fetch is replaced by one that fails
// the test if anything reaches it.

const KEY = 'sk-test-clave-ficticia-0123456789';
const TEXT = 'Texto secreto del cliente: el cafe cuesta cuatro dolares';
const REQUEST: SynthesisRequest = {
  text: TEXT,
  voiceId: 'VozFicticia123',
  settings: { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1, speakerBoost: true },
  purpose: 'voz_en_off',
};

const ok = (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({
      audio_base64: Buffer.from('FAKE-MP3-BYTES').toString('base64'),
      alignment: { characters: ['H', 'i'], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] },
      normalized_alignment: { characters: ['x'], character_start_times_seconds: [0], character_end_times_seconds: [1] },
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json', ...headers } },
  );

const failure = (status: number, detail: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ detail: { message: `echo of ${TEXT} with key ${KEY}`, ...detail } }), { status, headers });

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function provider(fetchMock: FetchMock, timeoutMs = 5000): ElevenLabsProvider {
  return new ElevenLabsProvider({ apiKey: KEY, model: 'tts-modelo-ficticio', timeoutMs, fetch: fetchMock });
}

async function falla(run: () => Promise<unknown>): Promise<VoiceProviderError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(VoiceProviderError);
    return error as VoiceProviderError;
  }
  throw new Error('expected a refusal');
}

function dump(error: Error): string {
  const fields: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(error)) fields[k] = (error as unknown as Record<string, unknown>)[k];
  return JSON.stringify(fields) + error.message + String(error.stack ?? '').split('\n')[0];
}

let globalFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  globalFetch = vi.fn(() => {
    throw new Error('the real network must never be used in tests');
  });
  vi.stubGlobal('fetch', globalFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ElevenLabsProvider.synthesize: success', () => {
  it('sends one POST to the with-timestamps endpoint with the fixed format, the key header and the settings', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok({}, { 'request-id': 'req_abc-123' }));
    const result = await provider(fetchMock).synthesize(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ELEVENLABS_BASE_URL}/v1/text-to-speech/VozFicticia123/with-timestamps?output_format=${ELEVENLABS_FORMAT}`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
    expect(JSON.parse(init?.body as string)).toEqual({
      text: TEXT,
      model_id: 'tts-modelo-ficticio',
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1, use_speaker_boost: true },
    });
    // language_code is never sent.
    expect(JSON.stringify(JSON.parse(init?.body as string))).not.toContain('language');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(globalFetch).not.toHaveBeenCalled();

    expect(result.audio.toString()).toBe('FAKE-MP3-BYTES');
    expect(result.model).toBe('tts-modelo-ficticio');
    expect(result.requestId).toBe('req_abc-123');
    // The alignment of the ORIGINAL text, not the normalized one.
    expect(result.alignment.characters).toEqual(['H', 'i']);
  });

  it('exposes the fixed format, the model of the configuration and its name', () => {
    const p = provider(vi.fn<typeof fetch>());
    expect(p).toMatchObject({ name: 'elevenlabs', format: 'mp3_44100_128', fileExtension: 'mp3', contentType: 'audio/mpeg' });
    expect(p.modelFor('voz_en_off')).toBe('tts-modelo-ficticio');
    expect(p.modelFor('smoke_test_voz')).toBe('tts-modelo-ficticio');
  });

  it('does not retry: a failure is one request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => failure(503, { type: 'service_unavailable' }));
    await falla(() => provider(fetchMock).synthesize(REQUEST));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ElevenLabsProvider.synthesize: error categories', () => {
  const cases: [string, Response, VoiceErrorKind, number][] = [
    ['401 authentication_error', failure(401, { type: 'authentication_error', code: 'invalid_api_key' }), 'auth', 401],
    ['403 authorization_error', failure(403, { type: 'authorization_error', code: 'voice_access_denied' }), 'auth', 403],
    ['402 payment_required', failure(402, { type: 'payment_required', code: 'insufficient_credits' }), 'quota', 402],
    ['401 with quota_exceeded', failure(401, { status: 'quota_exceeded' , code: 'quota_exceeded' }), 'quota', 401],
    ['429 rate_limit_exceeded', failure(429, { type: 'rate_limit_error', code: 'rate_limit_exceeded' }), 'rate_limit', 429],
    ['429 concurrent_limit_exceeded', failure(429, { type: 'rate_limit_error', code: 'concurrent_limit_exceeded' }), 'rate_limit', 429],
    ['429 system_busy', failure(429, { type: 'rate_limit_error', code: 'system_busy' }), 'rate_limit', 429],
    ['400 validation_error', failure(400, { type: 'validation_error', code: 'text_too_long' }), 'bad_request', 400],
    ['404 voice_not_found', failure(404, { type: 'not_found', code: 'voice_not_found' }), 'bad_request', 404],
    ['422', failure(422), 'bad_request', 422],
    ['500', failure(500, { type: 'internal_error' }), 'server', 500],
    ['503', failure(503, { type: 'service_unavailable', code: 'maintenance' }), 'server', 503],
  ];

  for (const [name, response, kind, status] of cases) {
    it(`${name} is "${kind}"`, async () => {
      const error = await falla(() => provider(vi.fn<typeof fetch>(async () => response)).synthesize(REQUEST));
      expect(error).toMatchObject({ kind, status });
    });
  }

  it('a network failure is "server" and a time-out is "timeout"', async () => {
    const network = await falla(() => provider(vi.fn<typeof fetch>(async () => { throw new TypeError(`fetch failed for ${TEXT} ${KEY}`); })).synthesize(REQUEST));
    expect(network).toMatchObject({ kind: 'server', reason: 'sin_conexion' });
    const timeout = await falla(() => provider(vi.fn<typeof fetch>(async () => { throw new DOMException('The operation timed out', 'TimeoutError'); })).synthesize(REQUEST));
    expect(timeout.kind).toBe('timeout');
    const aborted = await falla(() => provider(vi.fn<typeof fetch>(async () => { throw new DOMException('aborted', 'AbortError'); })).synthesize(REQUEST));
    expect(aborted.kind).toBe('timeout');
  });

  it('really times out when the server never answers', async () => {
    const hang = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const error = await falla(() => provider(hang, 30).synthesize(REQUEST));
    expect(error.kind).toBe('timeout');
  });

  it('marks rate limits, server errors and time-outs as retryable and the rest as not', async () => {
    expect(new VoiceProviderError('rate_limit').retryable).toBe(true);
    expect(new VoiceProviderError('server').retryable).toBe(true);
    expect(new VoiceProviderError('timeout').retryable).toBe(true);
    for (const kind of ['auth', 'quota', 'bad_request'] as const) expect(new VoiceProviderError(kind).retryable).toBe(false);
  });

  it('takes the request id from the body of the error, then from the headers, and drops one that is not a closed identifier', async () => {
    const fromBody = await falla(() => provider(vi.fn<typeof fetch>(async () => failure(500, { request_id: 'body_id-1' }, { 'request-id': 'header_id' }))).synthesize(REQUEST));
    expect(fromBody.requestId).toBe('body_id-1');
    const fromHeader = await falla(() => provider(vi.fn<typeof fetch>(async () => failure(500, {}, { 'x-request-id': 'header_id-2' }))).synthesize(REQUEST));
    expect(fromHeader.requestId).toBe('header_id-2');
    const malicious = await falla(() => provider(vi.fn<typeof fetch>(async () => failure(500, { request_id: `${TEXT} ${KEY}` }))).synthesize(REQUEST));
    expect(malicious.requestId).toBeUndefined();
  });

  it('maps the error type and code before the status', () => {
    expect(voiceErrorKind(400, 'payment_required')).toBe('quota');
    expect(voiceErrorKind(200, undefined, 'insufficient_credits')).toBe('quota');
    expect(voiceErrorKind(418)).toBe('bad_request');
    expect(voiceErrorKind(302)).toBe('server');
  });

  it('survives an error body that is not JSON', async () => {
    const error = await falla(() => provider(vi.fn<typeof fetch>(async () => new Response(`<html>${TEXT}</html>`, { status: 502 }))).synthesize(REQUEST));
    expect(error).toMatchObject({ kind: 'server', status: 502 });
  });
});

describe('ElevenLabsProvider.synthesize: invalid replies and inputs', () => {
  it('refuses a reply that is not JSON, has the wrong shape, mismatched alignment lengths, empty or oversized audio', async () => {
    const replies: Response[] = [
      new Response('not json', { status: 200 }),
      new Response(JSON.stringify({ audio_base64: 'AAAA' }), { status: 200 }),
      ok({ alignment: { characters: ['a', 'b'], character_start_times_seconds: [0], character_end_times_seconds: [1, 2] } }),
      ok({ audio_base64: '' }),
      ok({ audio_base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }),
      new Response('{}', { status: 200, headers: { 'content-length': String(16 * 1024 * 1024) } }),
    ];
    for (const reply of replies) {
      const error = await falla(() => provider(vi.fn<typeof fetch>(async () => reply)).synthesize(REQUEST));
      expect(error.kind).toBe('server');
      expect(error.reason).toMatch(/respuesta_/);
    }
  });

  it('refuses a voice id that could change the path, without calling fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    for (const voiceId of ['', 'a/b', '../x', 'a b', 'x?y=1', 'x#y', 'a'.repeat(65), 'voz%2F']) {
      const error = await falla(() => provider(fetchMock).synthesize({ ...REQUEST, voiceId }));
      expect(error).toMatchObject({ kind: 'bad_request', reason: 'voz_invalida' });
    }
    const empty = await falla(() => provider(fetchMock).synthesize({ ...REQUEST, text: '   ' }));
    expect(empty.reason).toBe('texto_vacio');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ElevenLabsProvider: neither the text nor the key leak', () => {
  it('no error carries the text, the key or the provider message, for every kind of failure', async () => {
    const attempts: (() => Response | Promise<Response>)[] = [
      () => failure(401, { type: 'authentication_error' }),
      () => failure(402, { type: 'payment_required' }),
      () => failure(429, { type: 'rate_limit_error' }),
      () => failure(400, { type: 'validation_error' }),
      () => failure(500),
      () => new Response(`${TEXT} ${KEY}`, { status: 200 }),
      () => {
        throw new TypeError(`${TEXT} ${KEY}`);
      },
      () => {
        throw new DOMException(`${TEXT} ${KEY}`, 'TimeoutError');
      },
    ];
    for (const attempt of attempts) {
      const error = await falla(() => provider(vi.fn<typeof fetch>(async () => attempt())).synthesize(REQUEST));
      const text = dump(error);
      for (const secret of [KEY, 'cafe', 'cuatro', 'secreto', 'echo of']) expect(text, secret).not.toContain(secret);
    }
  });

  it('the key never shows when the provider object is printed or serialized', () => {
    const p = provider(vi.fn<typeof fetch>());
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(String(Object.values(p))).not.toContain(KEY);
  });
});
