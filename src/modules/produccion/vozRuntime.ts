import type { MediaConfig, VoiceConfig } from '../../config/index.js';
import { createVoiceProvider } from '../../lib/ai/voice/index.js';
import { createAudioMeter } from '../../lib/media/ffmpeg/measureAudio.js';
import type { VozRuntime } from './vozReel.js';

/**
 * The voice side of reel production, from configuration (VOICE_PROVIDER, TTS_MODEL, ELEVENLABS_API_KEY,
 * TTS_TIMEOUT_MS, FFPROBE_PATH). Lazy on purpose: building it makes no request and starts no process; the
 * provider is only called when a reel of a client with a voice is produced. `undefined` with
 * VOICE_PROVIDER=none: reels are made with the silent track.
 */
export function createVozRuntime(voice: VoiceConfig, media: Pick<MediaConfig, 'ffprobePath' | 'ffprobeTimeoutMs'>): VozRuntime | undefined {
  const provider = createVoiceProvider(voice);
  if (provider === null) return undefined;
  return { provider, measureAudio: createAudioMeter({ ffprobePath: media.ffprobePath, timeoutMs: media.ffprobeTimeoutMs }) };
}
