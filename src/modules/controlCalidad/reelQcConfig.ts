import type { MediaConfig } from '../../config/index.js';
import type { ReelQcConfig } from './archivos.js';

/**
 * The FFmpeg side of quality control, from configuration: ffprobe reads the stored reel (Step 8) and FFmpeg
 * measures the loudness of a reel with a voice-over (Step 7d). Nothing is started here.
 */
export function reelQcConfig(media: Pick<MediaConfig, 'ffprobePath' | 'ffprobeTimeoutMs' | 'ffmpegPath' | 'ffmpegTimeoutMs'>): ReelQcConfig {
  return { ffprobePath: media.ffprobePath, ffprobeTimeoutMs: media.ffprobeTimeoutMs, ffmpegPath: media.ffmpegPath, ffmpegTimeoutMs: media.ffmpegTimeoutMs };
}
