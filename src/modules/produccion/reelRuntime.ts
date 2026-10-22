import type { MediaConfig, RemotionConfig } from '../../config/index.js';
import { createFfmpegToolingGuard } from '../../lib/media/ffmpeg/tooling.js';
import type { ReelRuntime } from './produccionService.js';
import { crearCapaTextoRemotion } from './remotionCapaTexto.js';

/**
 * The FFmpeg side of reel production, from configuration (FFMPEG_PATH, FFMPEG_TIMEOUT_MS, FFPROBE_PATH,
 * FFPROBE_TIMEOUT_MS). Lazy on purpose: the capability check runs once per process, the first time a
 * reel is produced, and a failed check is not remembered. Creating the runtime starts no process, so a
 * machine without FFmpeg still boots and still produces image pieces.
 *
 * With `remotion` (REMOTION_LICENCIA, REMOTION_NAVEGADOR, REMOTION_TIMEOUT_MS) the animated text templates are
 * wired too. Just as lazy: the adapter loads @remotion/renderer, opens the browser and builds the bundle only
 * inside the first templated render. With the license unset no template is picked and reels keep the PNG overlays.
 */
export function createReelRuntime(media: Pick<MediaConfig, 'ffmpegPath' | 'ffprobePath' | 'ffmpegTimeoutMs' | 'ffprobeTimeoutMs'>,
  remotion?: RemotionConfig,
): ReelRuntime {
  return {
    tooling: createFfmpegToolingGuard({ ffmpegPath: media.ffmpegPath, ffprobePath: media.ffprobePath }),
    ffmpegPath: media.ffmpegPath,
    ffprobePath: media.ffprobePath,
    ffmpegTimeoutMs: media.ffmpegTimeoutMs,
    ffprobeTimeoutMs: media.ffprobeTimeoutMs,
    ...(remotion
      ? { remotion: { licencia: remotion.licencia, capaTexto: crearCapaTextoRemotion({ licencia: remotion.licencia, navegador: remotion.navegador }), timeoutMs: remotion.timeoutMs } }
      : {}),
  };
}
