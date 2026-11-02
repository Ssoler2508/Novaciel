import type { SynthesisRequest, SynthesisResult, VoicePurpose, VoiceProvider } from './types.js';

// A voice for tests and development: no network, no cost. It writes a WAV file with a sine tone whose
// length follows the text (msPerChar per character) and a synthetic alignment, one character after
// another. Replies can be scripted (including errors); calls are recorded. The recorded calls hold the
// text because they are only for tests.

export const FAKE_VOICE_FORMAT = 'wav_16000';
const SAMPLE_RATE = 16_000;

export type ScriptedVoiceReply = { error: Error } | { durationMs: number } | { audio: Buffer };

export interface FakeVoiceOptions {
  name?: string;
  model?: string;
  /** Length of the tone per character of the text. */
  msPerChar?: number;
}

/** A 16-bit mono PCM WAV with a quiet sine tone. Deterministic: the same length gives the same bytes. */
export function sineWav(durationMs: number, frequencyHz = 220): Buffer {
  const samples = Math.max(1, Math.round((SAMPLE_RATE * durationMs) / 1000));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE) * 0.2 * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export class FakeVoiceProvider implements VoiceProvider {
  readonly name: string;
  readonly format = FAKE_VOICE_FORMAT;
  readonly fileExtension = 'wav';
  readonly contentType = 'audio/wav';
  readonly calls: SynthesisRequest[] = [];
  readonly #model: string;
  readonly #msPerChar: number;
  readonly #queue: ScriptedVoiceReply[] = [];

  constructor(options: FakeVoiceOptions = {}) {
    this.name = options.name ?? 'fake_voice';
    this.#model = options.model ?? 'fake-tts-model';
    this.#msPerChar = options.msPerChar ?? 65;
  }

  modelFor(_purpose: VoicePurpose): string {
    return this.#model;
  }

  /** Queues replies, answered in order; without any, the reply follows the text. */
  enqueue(...replies: ScriptedVoiceReply[]): this {
    this.#queue.push(...replies);
    return this;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    this.calls.push(request);
    const scripted = this.#queue.shift();
    if (scripted && 'error' in scripted) throw scripted.error;
    const characters = [...request.text];
    const step = this.#msPerChar / 1000;
    const alignment = {
      characters,
      character_start_times_seconds: characters.map((_c, i) => Math.round(i * step * 1000) / 1000),
      character_end_times_seconds: characters.map((_c, i) => Math.round((i + 1) * step * 1000) / 1000),
    };
    const audio = scripted && 'audio' in scripted ? scripted.audio : sineWav(scripted && 'durationMs' in scripted ? scripted.durationMs : characters.length * this.#msPerChar);
    return { audio, alignment, model: this.#model, requestId: `fake-${this.calls.length}` };
  }
}
