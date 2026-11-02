import type { VoiceConfig } from '../../../config/index.js';
import { ElevenLabsProvider } from './elevenLabsProvider.js';
import { FakeVoiceProvider } from './fakeVoiceProvider.js';
import type { VoiceProvider } from './types.js';

export * from './types.js';
export { voiceModelForPurpose, type VoiceModelSource } from './voiceTiers.js';
export { ElevenLabsProvider, ELEVENLABS_BASE_URL, ELEVENLABS_FORMAT, voiceErrorKind } from './elevenLabsProvider.js';
export { FakeVoiceProvider, FAKE_VOICE_FORMAT, sineWav, type ScriptedVoiceReply } from './fakeVoiceProvider.js';

/** Builds the provider chosen by configuration, or null for "none" (no voice-over: the silent track of 7b). Starts nothing. */
export function createVoiceProvider(cfg: VoiceConfig): VoiceProvider | null {
  if (cfg.provider === 'none') return null;
  if (cfg.provider === 'fake') return new FakeVoiceProvider(cfg.model ? { model: cfg.model } : {});
  if (!cfg.apiKey || !cfg.model) throw new Error('ELEVENLABS_API_KEY and TTS_MODEL are required for the elevenlabs provider');
  return new ElevenLabsProvider({ apiKey: cfg.apiKey.reveal(), model: cfg.model, timeoutMs: cfg.timeoutMs });
}
