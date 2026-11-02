import { z } from 'zod';
import { VoiceProviderError, type SynthesisRequest, type SynthesisResult, type VoiceErrorKind, type VoiceProvider, type VoicePurpose } from './types.js';

// ElevenLabs text-to-speech with timestamps (Step 7d, ADR-08), through the platform `fetch`: no SDK.
// Read on 2026-11-01: elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps and
// elevenlabs.io/docs/eleven-api/resources/errors. VERIFY with the real `voice:smoke` (checkpoint E): the
// `xi-api-key` header, the `request-id` response header and the character cost the account reports.
//
// Rules: no retries here (each retry is a paid call: the service decides); no `language_code` (it varies
// by model and multilingual_v2 does not take it); the key is revealed only to build the request; errors
// carry a category, the status and the request id, never the text, the key or the provider's message.

/** The provider's fixed API host. Not configurable by environment: the key is only ever sent here. */
export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
/** Fixed output format (VERIFY: 128 kbps MP3 needs no premium tier; 192 kbps needs Creator). */
export const ELEVENLABS_FORMAT = 'mp3_44100_128';

const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

const responseSchema = z.object({
  audio_base64: z.string().min(1),
  alignment: z.object({
    characters: z.array(z.string()),
    character_start_times_seconds: z.array(z.number()),
    character_end_times_seconds: z.array(z.number()),
  }),
});

const errorSchema = z.object({
  detail: z
    .object({ type: z.string().optional(), code: z.string().optional(), status: z.string().optional(), request_id: z.string().optional() })
    .passthrough()
    .optional(),
});

export interface ElevenLabsOptions {
  apiKey: string;
  /** TTS_MODEL. */
  model: string;
  timeoutMs: number;
  /** For tests only; production uses the fixed ElevenLabs URL. */
  baseUrl?: string;
  /** For tests only: a fake HTTP layer, so no network is used. */
  fetch?: typeof fetch;
}

/** Maps the error `type`/`code` of the reply first, then its HTTP status, to one of the fixed categories. */
export function voiceErrorKind(status: number, type?: string, code?: string): VoiceErrorKind {
  if (code === 'insufficient_credits' || code === 'quota_exceeded' || type === 'payment_required' || status === 402) return 'quota';
  if (type === 'rate_limit_error' || status === 429) return 'rate_limit';
  if (type === 'authentication_error' || type === 'authorization_error' || status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'server';
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ID.test(value) ? value : undefined;
}

export class ElevenLabsProvider implements VoiceProvider {
  readonly name = 'elevenlabs';
  readonly format = ELEVENLABS_FORMAT;
  readonly fileExtension = 'mp3';
  readonly contentType = 'audio/mpeg';
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: ElevenLabsOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs;
    this.#baseUrl = (options.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  modelFor(_purpose: VoicePurpose): string {
    return this.#model;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    // Before anything leaves: a voice id that could change the path is refused without a request.
    if (!VOICE_ID.test(request.voiceId)) throw new VoiceProviderError('bad_request', undefined, undefined, 'voz_invalida');
    if (request.text.trim() === '') throw new VoiceProviderError('bad_request', undefined, undefined, 'texto_vacio');

    const url = `${this.#baseUrl}/v1/text-to-speech/${request.voiceId}/with-timestamps?output_format=${ELEVENLABS_FORMAT}`;
    const body = JSON.stringify({
      text: request.text,
      model_id: this.#model,
      voice_settings: {
        stability: request.settings.stability,
        similarity_boost: request.settings.similarityBoost,
        style: request.settings.style,
        speed: request.settings.speed,
        use_speaker_boost: request.settings.speakerBoost,
      },
    });

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'xi-api-key': this.#apiKey },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new VoiceProviderError('timeout');
      // Network failure: do not forward its message (it could carry the URL or the request).
      throw new VoiceProviderError('server', undefined, undefined, 'sin_conexion');
    }

    const headerId = safeId(response.headers.get('request-id')) ?? safeId(response.headers.get('x-request-id'));

    if (!response.ok) {
      let type: string | undefined;
      let code: string | undefined;
      let bodyId: string | undefined;
      try {
        const text = (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
        const parsed = errorSchema.safeParse(JSON.parse(text));
        if (parsed.success) {
          type = parsed.data.detail?.type;
          code = parsed.data.detail?.code ?? parsed.data.detail?.status;
          bodyId = safeId(parsed.data.detail?.request_id);
        }
      } catch {
        // An unreadable error body is fine: the status alone decides.
      }
      throw new VoiceProviderError(voiceErrorKind(response.status, type, code), response.status, bodyId ?? headerId);
    }

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_RESPONSE_BYTES) throw new VoiceProviderError('server', response.status, headerId, 'respuesta_demasiado_grande');
    let raw: unknown;
    try {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new VoiceProviderError('server', response.status, headerId, 'respuesta_demasiado_grande');
      raw = JSON.parse(text);
    } catch (error) {
      if (error instanceof VoiceProviderError) throw error;
      throw new VoiceProviderError('server', response.status, headerId, 'respuesta_invalida');
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new VoiceProviderError('server', response.status, headerId, 'respuesta_invalida');
    const { alignment } = parsed.data;
    if (
      alignment.characters.length !== alignment.character_start_times_seconds.length ||
      alignment.characters.length !== alignment.character_end_times_seconds.length
    ) {
      throw new VoiceProviderError('server', response.status, headerId, 'respuesta_invalida');
    }
    const audio = Buffer.from(parsed.data.audio_base64, 'base64');
    if (audio.length === 0) throw new VoiceProviderError('server', response.status, headerId, 'respuesta_invalida');
    if (audio.length > MAX_AUDIO_BYTES) throw new VoiceProviderError('server', response.status, headerId, 'respuesta_demasiado_grande');

    return { audio, alignment, model: this.#model, ...(headerId ? { requestId: headerId } : {}) };
  }
}
