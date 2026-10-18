import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { MediaProbeError } from '../probe/types.js';
import { parseVideoFacts, type VideoFacts } from './parseVideoFacts.js';

// Reads the facts of a video file with ffprobe (Step 7b): displayed size, duration, frame rate,
// HDR, codecs, audio and tags. Same safe running as the upload probe: argument array, no shell, the
// path made absolute and prefixed with `file:`, a time limit, stderr drained and never kept.

const MAX_STDOUT_BYTES = 2_000_000;

export type ProbeSpawnFn = (
  command: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true },
) => ChildProcessWithoutNullStreams;

export interface ProbeVideoOptions {
  ffprobePath: string;
  timeoutMs: number;
  /** For tests: a fake `spawn`. */
  spawn?: ProbeSpawnFn;
}

/** Runs ffprobe on `filePath` and returns its facts, or throws MediaProbeError (fixed text, no output). */
export function probeVideo(filePath: string, options: ProbeVideoOptions): Promise<VideoFacts> {
  const spawn = options.spawn ?? (nodeSpawn as unknown as ProbeSpawnFn);
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', `file:${path.resolve(filePath)}`];
  return new Promise<VideoFacts>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.ffprobePath, args, { shell: false, windowsHide: true });
    } catch {
      reject(new MediaProbeError('not_found'));
      return;
    }

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new MediaProbeError('timeout'));
      });
    }, options.timeoutMs);

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
          resolve(parseVideoFacts(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}
