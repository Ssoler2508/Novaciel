import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { parseFfprobeOutput } from './parseFfprobe.js';
import { MediaProbeError, type MediaProbe, type ProbeResult } from './types.js';

const MAX_STDOUT_BYTES = 1_000_000;

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true },
) => ChildProcessWithoutNullStreams;

export interface FfprobeMediaProbeOptions {
  /** Path of the ffprobe executable, from config. */
  path: string;
  timeoutMs: number;
  /** For tests: a fake `spawn`. */
  spawn?: SpawnFn;
}

/**
 * Runs `ffprobe -v error -print_format json -show_format -show_streams file:<absolute path>`.
 * The arguments are an array and there is no shell. The path is made absolute and prefixed with
 * `file:`, so it can never be read as an option (a name starting with "-") or as a protocol
 * ("concat:", "http:"). stderr is drained and discarded, never kept or shown.
 */
export class FfprobeMediaProbe implements MediaProbe {
  readonly #path: string;
  readonly #timeoutMs: number;
  readonly #spawn: SpawnFn;

  constructor(options: FfprobeMediaProbeOptions) {
    this.#path = options.path;
    this.#timeoutMs = options.timeoutMs;
    this.#spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
  }

  probe(filePath: string): Promise<ProbeResult> {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', `file:${path.resolve(filePath)}`];
    return new Promise<ProbeResult>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.#spawn(this.#path, args, { shell: false, windowsHide: true });
      } catch {
        reject(new MediaProbeError('not_found'));
        return;
      }

      const timer = setTimeout(() => {
        finish(() => {
          child.kill('SIGKILL');
          reject(new MediaProbeError('timeout'));
        });
      }, this.#timeoutMs);

      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_STDOUT_BYTES) {
          finish(() => {
            child.kill('SIGKILL');
            reject(new MediaProbeError('output_too_large'));
          });
          return;
        }
        chunks.push(chunk);
      });
      // Drained so the process cannot block on a full pipe; the content is never used.
      child.stderr.on('data', () => undefined);

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(() => reject(new MediaProbeError(error.code === 'ENOENT' ? 'not_found' : 'exit_nonzero', undefined)));
      });
      child.on('close', (code: number | null) => {
        finish(() => {
          if (code !== 0) {
            reject(new MediaProbeError('exit_nonzero', code ?? undefined));
            return;
          }
          try {
            resolve(parseFfprobeOutput(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      });
    });
  }
}
