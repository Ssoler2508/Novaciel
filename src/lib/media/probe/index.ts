import type { MediaConfig } from '../../../config/index.js';
import { FfprobeMediaProbe } from './ffprobeMediaProbe.js';
import type { MediaProbe } from './types.js';

export type { MediaProbe, MediaProbeErrorCode, ProbeResult } from './types.js';
export { MediaProbeError } from './types.js';
export { parseFfprobeOutput } from './parseFfprobe.js';
export { FfprobeMediaProbe } from './ffprobeMediaProbe.js';
export { FakeMediaProbe } from './fakeMediaProbe.js';
export { isFfprobeAvailable } from './ffprobeAvailable.js';

/** Builds the real probe from configuration. */
export function createMediaProbe(cfg: Pick<MediaConfig, 'ffprobePath' | 'ffprobeTimeoutMs'>): MediaProbe {
  return new FfprobeMediaProbe({ path: cfg.ffprobePath, timeoutMs: cfg.ffprobeTimeoutMs });
}
