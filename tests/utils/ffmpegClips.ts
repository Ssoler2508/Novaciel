import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Source clips for the real-FFmpeg tests, made at test time with FFmpeg's own `lavfi` test sources in
// a temporary folder. Nothing is committed, nothing is a real person or place. Arguments are arrays;
// no shell.

function ffmpeg(args: readonly string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`test clip: ffmpeg failed (${result.status}): ${(result.stderr ?? '').slice(0, 400)}`);
}

export interface ClipOptions {
  seconds?: number;
  fps?: number;
  /** Default 720x1280, the smallest vertical size that needs no more than 1.5 times of enlarging. */
  width?: number;
  height?: number;
}

/** A solid-colour clip (no audio). `color` is a hex such as "3366cc". */
export function solidClip(dir: string, name: string, color: string, o: ClipOptions = {}): string {
  const file = path.join(dir, name);
  const { seconds = 6, fps = 30, width = 720, height = 1280 } = o;
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0x${color}:s=${width}x${height}:r=${fps}:d=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  return file;
}

/** A clip with a moving test pattern (no audio). */
export function patternClip(dir: string, name: string, o: ClipOptions & { extraFilter?: string; extraArgs?: readonly string[] } = {}): string {
  const file = path.join(dir, name);
  const { seconds = 6, fps = 30, width = 720, height = 1280, extraFilter, extraArgs = [] } = o;
  const filter = `testsrc2=s=${width}x${height}:r=${fps}:d=${seconds}${extraFilter ? `,${extraFilter}` : ''}`;
  ffmpeg(['-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...extraArgs, file]);
  return file;
}

/** A variable-frame-rate clip: frames are dropped irregularly, so the timestamps are not evenly spaced. */
export function variableFrameRateClip(dir: string, name: string, o: ClipOptions = {}): string {
  return patternClip(dir, name, { ...o, fps: 60, extraFilter: "select='lt(mod(n\\,7)\\,3)'", extraArgs: ['-fps_mode', 'vfr'] });
}

/**
 * A clip CODED landscape (1440x810) whose four quadrants are red (top left), lime (top right),
 * blue (bottom left) and yellow (bottom right), with a display matrix of `rotation` degrees
 * (counter-clockwise, as FFmpeg's -display_rotation). Played upright it is portrait 810x1440.
 */
export function rotatedQuadrantsClip(dir: string, name: string, rotation: number, o: ClipOptions = {}): string {
  const raw = path.join(dir, `coded-${name}`);
  const file = path.join(dir, name);
  const { seconds = 6, fps = 30 } = o;
  const quadrant = (x: number, y: number, color: string) => `drawbox=x=${x}:y=${y}:w=720:h=405:color=${color}:t=fill`;
  const filter = ['color=c=black:s=1440x810', `r=${fps}`, `d=${seconds}`].join(':') + ',' + [quadrant(0, 0, 'red'), quadrant(720, 0, 'lime'), quadrant(0, 405, 'blue'), quadrant(720, 405, 'yellow')].join(',');
  ffmpeg(['-f', 'lavfi', '-i', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', raw]);
  ffmpeg(['-display_rotation', String(rotation), '-i', raw, '-c', 'copy', file]);
  return file;
}

/** A clip with a title, a creation time, a location and a comment in its metadata. */
export function taggedClip(dir: string, name: string, tags: Readonly<Record<string, string>>, o: ClipOptions = {}): string {
  const file = path.join(dir, name);
  const { seconds = 6, fps = 30, width = 720, height = 1280 } = o;
  const metadata = Object.entries(tags).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);
  ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}:d=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...metadata, '-movflags', 'use_metadata_tags', file]);
  return file;
}

/** A 10-bit HDR clip tagged PQ (smpte2084) or HLG (arib-std-b67), BT.2020, HEVC. */
export function hdrClip(dir: string, name: string, transfer: 'smpte2084' | 'arib-std-b67', o: ClipOptions = {}): string {
  const file = path.join(dir, name);
  const { seconds = 6, fps = 30, width = 720, height = 1280 } = o;
  const filter = `testsrc2=s=${width}x${height}:r=${fps}:d=${seconds},format=yuv420p10le,setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=${transfer}:range=tv`;
  ffmpeg(['-f', 'lavfi', '-i', filter, '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error', file]);
  return file;
}

/** Copies a file with FFmpeg and extra arguments (stream copy), for tests that tamper with a good output. */
export function remux(input: string, output: string, extraArgs: readonly string[]): string {
  ffmpeg(['-i', input, '-c', 'copy', ...extraArgs, output]);
  return output;
}

/** One decoded frame at `seconds`, as an RGB pixel reader. */
export function framePng(video: string, seconds: number, output: string): string {
  ffmpeg(['-ss', String(seconds), '-i', video, '-frames:v', '1', output]);
  return output;
}
