import { probeVideo, type ProbeSpawnFn } from './probeVideo.js';

// Duration of an audio file in ms, with ffprobe (the same safe running as the video probe). Throws when
// the file has no audio stream or no duration. The result is what the voice-over code trusts, not the
// provider's alignment.

export interface MeasureAudioOptions {
  ffprobePath: string;
  timeoutMs: number;
  /** For tests: a fake `spawn`. */
  spawn?: ProbeSpawnFn;
}

export function createAudioMeter(options: MeasureAudioOptions): (filePath: string) => Promise<number> {
  return async (filePath) => {
    const facts = await probeVideo(filePath, { ffprobePath: options.ffprobePath, timeoutMs: options.timeoutMs, ...(options.spawn ? { spawn: options.spawn } : {}) });
    const ms = facts.audio?.duracionMs ?? facts.duracionMs;
    if (!facts.audio || ms === null || ms < 1) throw new Error('The file has no readable audio');
    return ms;
  };
}
