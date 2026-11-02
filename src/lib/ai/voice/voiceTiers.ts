// The ONE place where the voice model is chosen. Every paid voice call has a purpose; the provider maps
// the purpose to the model id from configuration (TTS_MODEL). No function accepts a model id from its
// caller. Today every purpose uses the same model; a second one would be added here.

import { VOICE_PURPOSES, type VoicePurpose } from './types.js';

export { VOICE_PURPOSES };
export type { VoicePurpose };

/** What a provider exposes so callers can price the model a purpose will use. */
export interface VoiceModelSource {
  modelFor(purpose: VoicePurpose): string;
}

/** The model id a purpose will be sent to (and priced with) on the given provider. */
export function voiceModelForPurpose(source: VoiceModelSource, purpose: VoicePurpose): string {
  if (!(VOICE_PURPOSES as readonly string[]).includes(purpose)) throw new Error('Unknown voice purpose');
  return source.modelFor(purpose);
}
