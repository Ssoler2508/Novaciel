import { describe, expect, it } from 'vitest';
import { describeFfprobe } from '../../../../tests/utils/ffmpeg.js';
import { createAudioMeter } from '../../media/ffmpeg/measureAudio.js';
import { createVoiceProvider } from './index.js';
import { FakeVoiceProvider, sineWav } from './fakeVoiceProvider.js';
import { ElevenLabsProvider } from './elevenLabsProvider.js';
import { voiceModelForPurpose } from './voiceTiers.js';
import { SecretValue } from '../../../config/secretValue.js';
import type { SynthesisRequest } from './types.js';

const REQUEST: SynthesisRequest = {
  text: 'Hola mundo',
  voiceId: 'voz-ficticia',
  settings: { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1, speakerBoost: true },
  purpose: 'voz_en_off',
};

describe('FakeVoiceProvider', () => {
  it('writes a valid WAV whose length follows the text, with a contiguous alignment', async () => {
    const fake = new FakeVoiceProvider({ msPerChar: 100 });
    const r = await fake.synthesize(REQUEST);
    expect(r.audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(r.audio.subarray(8, 16).toString('ascii')).toBe('WAVEfmt ');
    const dataBytes = r.audio.readUInt32LE(40);
    expect(dataBytes).toBe(r.audio.length - 44);
    // 10 characters at 100 ms = 1000 ms of 16 kHz 16-bit mono.
    expect(dataBytes).toBe(16_000 * 2);
    expect(r.alignment.characters.join('')).toBe('Hola mundo');
    expect(r.alignment.character_start_times_seconds[0]).toBe(0);
    expect(r.alignment.character_end_times_seconds.at(-1)).toBe(1);
    r.alignment.characters.forEach((_c, i) => {
      if (i > 0) expect(r.alignment.character_start_times_seconds[i]).toBe(r.alignment.character_end_times_seconds[i - 1]);
    });
    expect(r.model).toBe('fake-tts-model');
  });

  it('is deterministic', async () => {
    const a = await new FakeVoiceProvider().synthesize(REQUEST);
    const b = await new FakeVoiceProvider().synthesize(REQUEST);
    expect(a.audio.equals(b.audio)).toBe(true);
    expect(sineWav(500).equals(sineWav(500))).toBe(true);
  });

  it('records calls and answers scripted errors, durations and audio', async () => {
    const fake = new FakeVoiceProvider();
    fake.enqueue({ error: new Error('boom') }, { durationMs: 250 }, { audio: Buffer.from('xyz') });
    await expect(fake.synthesize(REQUEST)).rejects.toThrow('boom');
    expect((await fake.synthesize(REQUEST)).audio.readUInt32LE(40)).toBe(8000);
    expect((await fake.synthesize(REQUEST)).audio.toString()).toBe('xyz');
    expect(fake.calls).toHaveLength(3);
    expect(fake).toMatchObject({ name: 'fake_voice', format: 'wav_16000', fileExtension: 'wav' });
  });
});

describe('voice routing and the factory', () => {
  it('the model of a purpose comes from the provider (one place)', () => {
    expect(voiceModelForPurpose(new FakeVoiceProvider({ model: 'm-1' }), 'voz_en_off')).toBe('m-1');
    expect(() => voiceModelForPurpose(new FakeVoiceProvider(), 'otra' as never)).toThrow(/Unknown voice purpose/);
  });

  it('createVoiceProvider: none is null, fake and elevenlabs follow the configuration', () => {
    expect(createVoiceProvider({ provider: 'none', model: undefined, timeoutMs: 1000 })).toBeNull();
    expect(createVoiceProvider({ provider: 'fake', model: 'fake-tts-model', timeoutMs: 1000 })).toBeInstanceOf(FakeVoiceProvider);
    const real = createVoiceProvider({ provider: 'elevenlabs', model: 'm', timeoutMs: 1000, apiKey: new SecretValue('k') });
    expect(real).toBeInstanceOf(ElevenLabsProvider);
    expect(() => createVoiceProvider({ provider: 'elevenlabs', model: 'm', timeoutMs: 1000 })).toThrow(/required/);
  });
});

describeFfprobe('audio meter with the real ffprobe', () => {
  it('measures the fake voice file', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'novaciel-medidor-'));
    try {
      const file = path.join(dir, 'voz ficticia ñ.wav'); // a space and an accent in the path
      await writeFile(file, sineWav(1500));
      const ms = await createAudioMeter({ ffprobePath: 'ffprobe', timeoutMs: 15_000 })(file);
      expect(Math.abs(ms - 1500)).toBeLessThanOrEqual(5);
      await writeFile(file, Buffer.from('not audio'));
      await expect(createAudioMeter({ ffprobePath: 'ffprobe', timeoutMs: 15_000 })(file)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
