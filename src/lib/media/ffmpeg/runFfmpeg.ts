import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// Runs ffmpeg with an argument ARRAY, never through a shell. Every run has a time limit and is
// killed when it passes. FFmpeg's stderr can contain paths and metadata, so it is kept only in
// memory (capped), used once to pick a fixed category, and then dropped: it never goes into an error
// message, a log or a return value.

export type FfmpegRunCategory =
  | 'no_encontrado' // the executable could not be started
  | 'timeout'
  | 'fuente_danada' // an input is unreadable or corrupt
  | 'filtro' // the filter graph was rejected
  | 'codificador' // the encoder could not start
  | 'disco_lleno'
  | 'desconocido';

const MESSAGES: Record<FfmpegRunCategory, string> = {
  no_encontrado: 'FFmpeg could not be started',
  timeout: 'FFmpeg timed out and was stopped',
  fuente_danada: 'FFmpeg could not read a source file',
  filtro: 'FFmpeg rejected the filter graph',
  codificador: 'FFmpeg could not start the encoder',
  disco_lleno: 'There is no space left to write the output',
  desconocido: 'FFmpeg failed',
};

/** A failed FFmpeg run. The message is fixed text plus the exit code; never FFmpeg's output. */
export class FfmpegRunError extends Error {
  constructor(
    readonly categoria: FfmpegRunCategory,
    readonly exitCode?: number,
  ) {
    super(`${MESSAGES[categoria]}${exitCode === undefined ? '' : ` (exit code ${exitCode})`}`);
    this.name = 'FfmpegRunError';
  }
}

export type RunSpawnFn = (
  command: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true },
) => ChildProcessWithoutNullStreams;

export interface RunFfmpegOptions {
  /** Path of the ffmpeg executable, from config. */
  ffmpegPath: string;
  timeoutMs: number;
  /** For tests: a fake `spawn`. */
  spawn?: RunSpawnFn;
}

const MAX_STDERR_BYTES = 64 * 1024;
/** After SIGKILL, how long to wait for the process to be gone before giving up on it. */
const KILL_GRACE_MS = 5000;

/** Picks the category from FFmpeg's stderr. The text is not kept by the caller. */
export function classifyFfmpegStderr(stderr: string): FfmpegRunCategory {
  if (/No space left|ENOSPC/i.test(stderr)) return 'disco_lleno';
  if (/Invalid data found|moov atom not found|Error opening input|Could not find codec parameters|End of file/i.test(stderr)) return 'fuente_danada';
  if (/Error while opening encoder|Could not open encoder|Unknown encoder|Encoder .* not found|Error initializing output stream/i.test(stderr)) return 'codificador';
  if (/Error (re)?initializing filter|Error while filtering|Filtergraph|No such filter|Invalid filtergraph|Cannot find a matching stream/i.test(stderr)) return 'filtro';
  return 'desconocido';
}

/**
 * Runs `ffmpeg <args>`. Resolves when it exits with 0; rejects with FfmpegRunError otherwise. On a
 * timeout the process is killed and the promise rejects only once the process is gone, so the caller
 * can remove its temporary folder without a file still being written.
 */
export function runFfmpeg(args: readonly string[], options: RunFfmpegOptions): Promise<void> {
  const spawn = options.spawn ?? (nodeSpawn as unknown as RunSpawnFn);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      action();
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.ffmpegPath, args, { shell: false, windowsHide: true });
    } catch {
      reject(new FfmpegRunError('no_encontrado'));
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      graceTimer = setTimeout(() => finish(() => reject(new FfmpegRunError('timeout'))), KILL_GRACE_MS);
    }, options.timeoutMs);

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    // Drained so the process cannot block on a full pipe; the content is never used.
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSize >= MAX_STDERR_BYTES) return;
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new FfmpegRunError(timedOut ? 'timeout' : error.code === 'ENOENT' ? 'no_encontrado' : 'desconocido')));
    });
    child.on('close', (code: number | null) => {
      finish(() => {
        if (timedOut) {
          reject(new FfmpegRunError('timeout'));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const categoria = classifyFfmpegStderr(Buffer.concat(stderrChunks).toString('utf8'));
        reject(new FfmpegRunError(categoria, code ?? undefined));
      });
    });
  });
}
