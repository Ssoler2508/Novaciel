import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

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

/** The four colours of the upright pattern, as RGB. */
export const PATTERN_COLORS = {
  blue: [0, 0, 255],
  red: [255, 0, 0],
  yellow: [255, 255, 0],
  lime: [0, 255, 0],
} as const;
export type PatternColor = keyof typeof PATTERN_COLORS;

/**
 * The pattern a viewer must SEE, upright, whatever the display matrix of the file: top left blue,
 * top right red, bottom left yellow, bottom right lime. Each entry also gives the point to sample in
 * a 1080x1920 frame.
 */
export const UPRIGHT_PATTERN: readonly { name: PatternColor; x: number; y: number }[] = [
  { name: 'blue', x: 270, y: 480 },
  { name: 'red', x: 810, y: 480 },
  { name: 'yellow', x: 270, y: 1440 },
  { name: 'lime', x: 810, y: 1440 },
];

/**
 * A phone-style clip with a display matrix, built so that the expected picture is known BY
 * CONSTRUCTION, not by looking at FFmpeg's output. The upright pattern (810x1440, UPRIGHT_PATTERN) is
 * rotated clockwise by `rotation` degrees to make the CODED frame (1440x810); the display matrix then
 * asks players to turn it back counter-clockwise by `rotation` degrees (FFmpeg's -display_rotation), so
 * a correct reader shows the upright pattern again. `rotation` is 90 or 270 (that is, -90).
 */
export async function rotatedQuadrantsClip(dir: string, name: string, rotation: 90 | 270, o: ClipOptions = {}): Promise<string> {
  const { seconds = 6, fps = 30 } = o;
  const rgb = (c: PatternColor) => ({ r: PATTERN_COLORS[c][0], g: PATTERN_COLORS[c][1], b: PATTERN_COLORS[c][2] });
  const quadrant = (color: PatternColor, left: number, top: number) => ({ input: { create: { width: 405, height: 720, channels: 3 as const, background: rgb(color) } }, left, top });
  const upright = await sharp({ create: { width: 810, height: 1440, channels: 3, background: '#000000' } })
    .composite([quadrant('blue', 0, 0), quadrant('red', 405, 0), quadrant('yellow', 0, 720), quadrant('lime', 405, 720)])
    .png()
    .toBuffer();
  const coded = await sharp(upright).rotate(rotation).png().toBuffer(); // clockwise
  const codedPng = path.join(dir, `coded-${name}.png`);
  const raw = path.join(dir, `coded-${name}`);
  await writeFile(codedPng, coded);
  ffmpeg(['-loop', '1', '-framerate', String(fps), '-i', codedPng, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', raw]);
  const file = path.join(dir, name);
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
