import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/index.js';
import { FfmpegToolingError } from '../../lib/media/ffmpeg/tooling.js';
import { createReelRuntime } from './reelRuntime.js';

const base = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  LOG_LEVEL: 'info',
  LOCAL_STORAGE_SIGNING_SECRET: 'x'.repeat(32),
  SECRETS_KEYS: `1:${Buffer.alloc(32, 1).toString('base64')}`,
  SECRETS_ACTIVE_KEY_VERSION: '1',
};

describe('createReelRuntime', () => {
  it('takes the paths and time limits from the configuration', () => {
    const media = loadConfig({ ...base, FFMPEG_PATH: 'C:\tools\ffmpeg.exe', FFMPEG_TIMEOUT_MS: '120000', FFPROBE_PATH: 'C:\tools\ffprobe.exe', FFPROBE_TIMEOUT_MS: '5000' }).media;
    expect(createReelRuntime(media)).toMatchObject({
      ffmpegPath: 'C:\tools\ffmpeg.exe',
      ffprobePath: 'C:\tools\ffprobe.exe',
      ffmpegTimeoutMs: 120_000,
      ffprobeTimeoutMs: 5000,
    });
    expect(createReelRuntime(loadConfig(base).media)).toMatchObject({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', ffmpegTimeoutMs: 600_000, ffprobeTimeoutMs: 15_000 });
  });

  it('starts no process when it is created; a missing FFmpeg shows up at the first reel, and is not remembered', async () => {
    const runtime = createReelRuntime({ ffmpegPath: 'definitely-not-ffmpeg-7781', ffprobePath: 'definitely-not-ffprobe-7781', ffmpegTimeoutMs: 10_000, ffprobeTimeoutMs: 1000 });
    // Created without error even though nothing exists; the check happens when asked.
    await expect(runtime.tooling()).rejects.toBeInstanceOf(FfmpegToolingError);
    await expect(runtime.tooling()).rejects.toMatchObject({ code: 'not_found' });
  });
});
