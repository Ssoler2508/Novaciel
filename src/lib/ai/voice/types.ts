// Provider-neutral voice (text-to-speech) interface. Implementations: FakeVoiceProvider (tests and
// development) and ElevenLabsProvider. The text sent is CLIENT CONTENT: nothing in this layer logs it,
// puts it in an error or keeps it beyond the call.

/** Why a voice is asked for. The purpose decides the model (see voiceTiers.ts). */
export const VOICE_PURPOSES = ['voz_en_off', 'smoke_test_voz'] as const;
export type VoicePurpose = (typeof VOICE_PURPOSES)[number];

export interface VoiceSettings {
  /** 0 to 1. */
  stability: number;
  /** 0 to 1. */
  similarityBoost: number;
  /** 0 to 1. */
  style: number;
  speed: number;
  speakerBoost: boolean;
}

export interface SynthesisRequest {
  /** The prepared text, exactly what is spoken. */
  text: string;
  /** A voice id of the provider's stock library, chosen per client. */
  voiceId: string;
  settings: VoiceSettings;
  purpose: VoicePurpose;
}

/** The provider's alignment of the ORIGINAL text, one entry per character, in seconds. */
export interface CharacterAlignmentSeconds {
  characters: readonly string[];
  character_start_times_seconds: readonly number[];
  character_end_times_seconds: readonly number[];
}

export interface SynthesisResult {
  audio: Buffer;
  alignment: CharacterAlignmentSeconds;
  /** The model that was asked for. */
  model: string;
  /** The provider's request id, for support. Only a closed identifier. */
  requestId?: string;
}

export interface VoiceProvider {
  /** Provider name as used in the price table and the spend ledger (for example "elevenlabs"). */
  readonly name: string;
  /** The fixed output format; it is part of the cache key. */
  readonly format: string;
  /** File extension of that format, without the dot. */
  readonly fileExtension: string;
  readonly contentType: string;
  /** The model id configured for a purpose. */
  modelFor(purpose: VoicePurpose): string;
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}

export type VoiceErrorKind = 'auth' | 'quota' | 'rate_limit' | 'bad_request' | 'server' | 'timeout';

/**
 * A failed voice call. The message and fields carry the category, the status, the provider's request id
 * and a fixed reason: NEVER the text, the key or the body of the provider's reply (it may repeat the text).
 */
export class VoiceProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: VoiceErrorKind,
    readonly status?: number,
    readonly requestId?: string,
    readonly reason?: string,
  ) {
    super(
      `Voice request failed: ${kind}${status ? ` (status ${status})` : ''}${reason ? ` [${reason}]` : ''}${requestId ? ` [request ${requestId}]` : ''}`,
    );
    this.name = 'VoiceProviderError';
    this.retryable = kind === 'rate_limit' || kind === 'server' || kind === 'timeout';
  }
}
