import { describe, expect, it, vi } from 'vitest';
import { SecretValue } from '../../config/secretValue.js';
import { ElevenLabsProvider } from '../../lib/ai/voice/elevenLabsProvider.js';
import { FakeVoiceProvider } from '../../lib/ai/voice/fakeVoiceProvider.js';
import { reelQcConfig } from '../controlCalidad/reelQcConfig.js';
import { createVozRuntime } from './vozRuntime.js';

const media = { ffprobePath: 'ffprobe', ffprobeTimeoutMs: 15_000, ffmpegPath: 'ffmpeg', ffmpegTimeoutMs: 600_000 };

describe('createVozRuntime', () => {
  it('none gives no runtime: reels keep the silent track', () => {
    expect(createVozRuntime({ provider: 'none', model: undefined, timeoutMs: 30_000 }, media)).toBeUndefined();
  });

  it('fake gives the fake provider and an audio meter', () => {
    const runtime = createVozRuntime({ provider: 'fake', model: 'fake-tts-model', timeoutMs: 30_000 }, media)!;
    expect(runtime.provider).toBeInstanceOf(FakeVoiceProvider);
    expect(runtime.provider.modelFor('voz_en_off')).toBe('fake-tts-model');
    expect(typeof runtime.measureAudio).toBe('function');
  });

  it('elevenlabs is built from the configuration WITHOUT any request, and its model and key come only from there', () => {
    const globalFetch = vi.fn(() => {
      throw new Error('building the runtime must not use the network');
    });
    vi.stubGlobal('fetch', globalFetch);
    try {
      const runtime = createVozRuntime({ provider: 'elevenlabs', model: 'tts-modelo-ficticio', timeoutMs: 5000, apiKey: new SecretValue('xi-clave-ficticia') }, media)!;
      expect(runtime.provider).toBeInstanceOf(ElevenLabsProvider);
      expect(runtime.provider.modelFor('voz_en_off')).toBe('tts-modelo-ficticio');
      expect(globalFetch).not.toHaveBeenCalled();
      expect(JSON.stringify(runtime)).not.toContain('xi-clave-ficticia');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('elevenlabs without its key or model is refused at build time, not at the first call', () => {
    expect(() => createVozRuntime({ provider: 'elevenlabs', model: 'm', timeoutMs: 1000 }, media)).toThrow(/required/);
    expect(() => createVozRuntime({ provider: 'elevenlabs', model: undefined, timeoutMs: 1000, apiKey: new SecretValue('k') }, media)).toThrow(/required/);
  });
});

describe('reelQcConfig', () => {
  it('carries the ffprobe and FFmpeg paths and time limits of the media configuration', () => {
    expect(reelQcConfig(media)).toEqual({ ffprobePath: 'ffprobe', ffprobeTimeoutMs: 15_000, ffmpegPath: 'ffmpeg', ffmpegTimeoutMs: 600_000 });
  });
});
