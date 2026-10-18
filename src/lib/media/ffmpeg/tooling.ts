import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isFfprobeAvailable } from '../probe/ffprobeAvailable.js';

// Checks that the FFmpeg on this machine can do what reel production needs, BEFORE a reel is
// produced (Step 7b). The commands are fixed (`-version`, `-encoders`, `-filters`); nothing from a
// client ever reaches them. Errors carry fixed text and the NAMES of what is missing, never the
// output of FFmpeg.

/** Encoders a reel needs: H.264 video and AAC audio. */
export const REQUIRED_ENCODERS = ['libx264', 'aac'] as const;
/**
 * Filters a reel needs: size (`scale`, `crop`), constant frame rate (`fps`), cuts (`trim`, `setpts`),
 * joining (`concat`), the text overlays (`overlay`), pixel format (`format`) and the silent audio
 * track (`anullsrc`).
 */
export const REQUIRED_FILTERS = ['scale', 'crop', 'overlay', 'concat', 'fps', 'format', 'trim', 'setpts', 'anullsrc'] as const;
/** Filters that tone-map HDR to SDR. Without them only HDR sources are refused; everything else works. */
export const HDR_FILTERS = ['zscale', 'tonemap'] as const;

const TOOLING_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 2_000_000;

export type FfmpegToolingErrorCode = 'not_found' | 'timeout' | 'exit_nonzero' | 'unreadable' | 'missing';

export class FfmpegToolingError extends Error {
  constructor(
    readonly code: FfmpegToolingErrorCode,
    /** Names of the missing programs, encoders and filters (code "missing" only). */
    readonly missing: readonly string[] = [],
  ) {
    super(
      {
        not_found: 'FFmpeg could not be started: check FFMPEG_PATH',
        timeout: 'FFmpeg did not answer in time',
        exit_nonzero: 'FFmpeg failed while checking its features',
        unreadable: 'FFmpeg answered with something that could not be understood',
        missing: `FFmpeg is missing what reel production needs: ${missing.join(', ')}`,
      }[code],
    );
    this.name = 'FfmpegToolingError';
  }
}

export interface FfmpegTooling {
  /** For example "9.0.2-full_build-www.gyan.dev". */
  version: string;
  /** True when HDR sources can be tone-mapped to SDR. */
  hdr: boolean;
}

export type ToolingSpawnFn = (
  command: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true },
) => ChildProcessWithoutNullStreams;

export interface FfmpegToolingOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** For tests. */
  spawn?: ToolingSpawnFn;
  ffprobeAvailable?: (ffprobePath: string) => boolean;
  timeoutMs?: number;
}

/** The version in the first line of `ffmpeg -version`, or null. */
export function parseFfmpegVersion(output: string): string | null {
  const match = /^ffmpeg version (\S+)/m.exec(output);
  return match?.[1] ?? null;
}

/**
 * The names listed by `ffmpeg -encoders` or `-filters`. A listed line starts with a flags column
 * (for example "V....D" or "T.C") followed by the name; the legend lines ("V..... = Video") are skipped.
 */
export function parseFeatureNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const [flags, name] = line.trim().split(/\s+/);
    if (flags === undefined || name === undefined || name === '=') continue;
    // Encoders: type, frame-level threads, slice threads, experimental, draw_horiz_band, direct rendering.
    // Filters: timeline, slice threads, command support (the last column is not always printed).
    const isListed = /^[VAS][.F][.S][.X][.B][.D]$/.test(flags) || /^[.T][.S][.C]?$/.test(flags);
    if (isListed && /^[\w.-]+$/.test(name)) names.add(name);
  }
  return names;
}

/** Pure: what is missing, and whether HDR works, given the three outputs. */
export function evaluateTooling(input: { versionOutput: string; encodersOutput: string; filtersOutput: string }): FfmpegTooling & { missing: string[] } {
  const version = parseFfmpegVersion(input.versionOutput);
  if (version === null) throw new FfmpegToolingError('unreadable');
  const encoders = parseFeatureNames(input.encodersOutput);
  const filters = parseFeatureNames(input.filtersOutput);
  if (encoders.size === 0 || filters.size === 0) throw new FfmpegToolingError('unreadable');
  const missing = [...REQUIRED_ENCODERS.filter((name) => !encoders.has(name)), ...REQUIRED_FILTERS.filter((name) => !filters.has(name))];
  return { version, hdr: HDR_FILTERS.every((name) => filters.has(name)), missing };
}

function capture(command: string, args: readonly string[], timeoutMs: number, spawn: ToolingSpawnFn): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true });
    } catch {
      reject(new FfmpegToolingError('not_found'));
      return;
    }
    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new FfmpegToolingError('timeout'));
      });
    }, timeoutMs);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) {
        finish(() => {
          child.kill('SIGKILL');
          reject(new FfmpegToolingError('unreadable'));
        });
        return;
      }
      chunks.push(chunk);
    });
    // Drained so the process cannot block on a full pipe; never kept or shown.
    child.stderr.on('data', () => undefined);
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new FfmpegToolingError(error.code === 'ENOENT' ? 'not_found' : 'exit_nonzero')));
    });
    child.on('close', (code: number | null) => {
      finish(() => (code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new FfmpegToolingError('exit_nonzero'))));
    });
  });
}

/**
 * Runs `ffmpeg -version`, `-encoders` and `-filters` and checks ffprobe. Throws FfmpegToolingError
 * (code "missing" lists the names) when reel production cannot work on this machine.
 */
export async function checkFfmpegTooling(options: FfmpegToolingOptions): Promise<FfmpegTooling> {
  const spawn = options.spawn ?? (nodeSpawn as unknown as ToolingSpawnFn);
  const timeoutMs = options.timeoutMs ?? TOOLING_TIMEOUT_MS;
  // Sequential on purpose: three short commands, and a missing binary fails on the first one.
  const versionOutput = await capture(options.ffmpegPath, ['-version'], timeoutMs, spawn);
  const encodersOutput = await capture(options.ffmpegPath, ['-hide_banner', '-encoders'], timeoutMs, spawn);
  const filtersOutput = await capture(options.ffmpegPath, ['-hide_banner', '-filters'], timeoutMs, spawn);
  const { missing, ...tooling } = evaluateTooling({ versionOutput, encodersOutput, filtersOutput });
  const ffprobeOk = (options.ffprobeAvailable ?? isFfprobeAvailable)(options.ffprobePath);
  const all = [...missing, ...(ffprobeOk ? [] : ['ffprobe'])];
  if (all.length > 0) throw new FfmpegToolingError('missing', all);
  return tooling;
}

/**
 * The check once per process: the first success is remembered, so every reel after it costs nothing.
 * A failure is not remembered, so installing FFmpeg does not need a restart.
 */
export function createFfmpegToolingGuard(options: FfmpegToolingOptions): () => Promise<FfmpegTooling> {
  let ok: Promise<FfmpegTooling> | undefined;
  return () => {
    if (ok === undefined) {
      const attempt = checkFfmpegTooling(options);
      ok = attempt;
      attempt.catch(() => {
        if (ok === attempt) ok = undefined;
      });
    }
    return ok;
  };
}
