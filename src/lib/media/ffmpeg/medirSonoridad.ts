import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

// Loudness of the audio of a file (Step 7d): integrated loudness (LUFS, EBU R128) and true peak (dBTP), read
// from the summary that FFmpeg's `ebur128` filter prints at the end of a run. FFmpeg's stderr can hold paths
// and metadata, so it is kept only in memory (capped), used once to read the two numbers, and dropped: it
// never goes into an error, a log or a return value. Same safe running as the other FFmpeg calls: argument
// array, no shell, the path made absolute and prefixed with `file:`, a time limit.

export type MedicionSonoridadCategoria = 'no_encontrado' | 'timeout' | 'fallo' | 'sin_resumen';

const MESSAGES: Record<MedicionSonoridadCategoria, string> = {
  no_encontrado: 'FFmpeg could not be started',
  timeout: 'The loudness measurement timed out and was stopped',
  fallo: 'FFmpeg could not measure the loudness',
  sin_resumen: 'FFmpeg did not report a loudness summary',
};

/** A failed measurement. The message is fixed text; never FFmpeg's output. */
export class MedicionSonoridadError extends Error {
  constructor(readonly categoria: MedicionSonoridadCategoria) {
    super(MESSAGES[categoria]);
    this.name = 'MedicionSonoridadError';
  }
}

export interface Sonoridad {
  /** Integrated loudness, LUFS. EBU R128 floors it at -70 for silence. */
  integradaLufs: number;
  /** Highest true peak, dBTP; null when FFmpeg reports none (digital silence prints -inf). */
  picoVerdaderoDbtp: number | null;
}

const MAX_STDERR_BYTES = 256 * 1024;

/** Reads the LAST `Summary` block of the `ebur128` log. Throws MedicionSonoridadError('sin_resumen') when there is none. */
export function leerResumenEbur128(stderr: string): Sonoridad {
  const inicio = stderr.lastIndexOf('Summary:');
  if (inicio < 0) throw new MedicionSonoridadError('sin_resumen');
  const resumen = stderr.slice(inicio);
  const integrada = /^\s*I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/m.exec(resumen);
  if (!integrada) throw new MedicionSonoridadError('sin_resumen');
  const pico = /^\s*Peak:\s+(-?\d+(?:\.\d+)?|-inf)\s+dBFS/m.exec(resumen);
  const valorPico = pico && pico[1] !== '-inf' ? Number(pico[1]) : null;
  return { integradaLufs: Number(integrada[1]), picoVerdaderoDbtp: valorPico };
}

export type MedirSpawnFn = (
  command: string,
  args: readonly string[],
  options: { shell: false; windowsHide: true },
) => ChildProcessWithoutNullStreams;

export interface MedirSonoridadOptions {
  ffmpegPath: string;
  timeoutMs: number;
  /** For tests: a fake `spawn`. */
  spawn?: MedirSpawnFn;
}

/** Measures the audio of `filePath` (any file with an audio stream). */
export function medirSonoridad(filePath: string, options: MedirSonoridadOptions): Promise<Sonoridad> {
  const spawn = options.spawn ?? (nodeSpawn as unknown as MedirSpawnFn);
  // framelog=quiet: without it ebur128 logs a line every 100 ms.
  const args = ['-nostdin', '-hide_banner', '-nostats', '-loglevel', 'info', '-i', `file:${path.resolve(filePath)}`, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'];
  return new Promise<Sonoridad>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.ffmpegPath, args, { shell: false, windowsHide: true });
    } catch {
      reject(new MedicionSonoridadError('no_encontrado'));
      return;
    }
    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new MedicionSonoridadError('timeout'));
      });
    }, options.timeoutMs);

    let stderr = '';
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep the tail: the summary is the last thing FFmpeg prints.
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new MedicionSonoridadError(error.code === 'ENOENT' ? 'no_encontrado' : 'fallo')));
    });
    child.on('close', (code: number | null) => {
      finish(() => {
        if (code !== 0) {
          reject(new MedicionSonoridadError('fallo'));
          return;
        }
        try {
          resolve(leerResumenEbur128(stderr));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}
