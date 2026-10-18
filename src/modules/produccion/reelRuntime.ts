import type { MediaConfig } from '../../config/index.js';
import { createFfmpegToolingGuard } from '../../lib/media/ffmpeg/tooling.js';
import type { ReelRuntime } from './produccionService.js';

/**
 * The FFmpeg side of reel production, from configuration (FFMPEG_PATH, FFMPEG_TIMEOUT_MS, FFPROBE_PATH,
 * FFPROBE_TIMEOUT_MS). Lazy on purpose: the capability check runs once per process, the first time a
 * reel is produced, and a failed check is not remembered. Creating the runtime starts no process, so a
 * machine without FFmpeg still boots and still produces image pieces.
 */
export function createReelRuntime(media: Pick<MediaConfig, 'ffmpegPath' | 'ffprobePath' | 'ffmpegTimeoutMs' | 'ffprobeTimeoutMs'>): ReelRuntime {
  return {
    tooling: createFfmpegToolingGuard({ ffmpegPath: media.ffmpegPath, ffprobePath: media.ffprobePath }),
    ffmpegPath: media.ffmpegPath,
    ffprobePath: media.ffprobePath,
    ffmpegTimeoutMs: media.ffmpegTimeoutMs,
    ffprobeTimeoutMs: media.ffprobeTimeoutMs,
  };
}
