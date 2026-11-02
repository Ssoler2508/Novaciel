import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, type RunFfmpegOptions } from '../../src/lib/media/ffmpeg/runFfmpeg.js';

// TEST-ONLY. Memoizes the reel render so that tests whose subject is what happens AROUND the render
// (storage failures, races, rights lost mid-flow...) do not re-encode the same video again and again.
// It never lives in src/: production always runs FFmpeg for real.
//
// The first time a render is requested it runs the real FFmpeg. Later requests with the same arguments AND the
// same input bytes get a byte-identical copy of that result at the requested output path. Everything after the
// render (ffprobe, verifyReelOutput, hashing, storing, the database) still runs for real on the copy.
// The key is the arguments with every existing file replaced by its SHA-256, so a different clip, overlay,
// voice or filter graph is a different key. A temporary-folder name inside an argument makes the key miss
// (an extra real render), never a wrong hit. Failed runs are not cached.

export type RunFfmpegFn = (args: readonly string[], options: RunFfmpegOptions) => Promise<void>;

export interface RenderCache {
  /** Same signature as runFfmpeg. */
  run: RunFfmpegFn;
  /** Real FFmpeg runs and copies served from the cache. */
  stats: { real: number; copies: number };
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export function createRenderCache(cacheDir: string, realRun: RunFfmpegFn = runFfmpeg): RenderCache {
  const done = new Map<string, string>();
  const inFlight = new Map<string, Promise<string>>();
  const stats = { real: 0, copies: 0 };
  let n = 0;

  const run: RunFfmpegFn = async (args, options) => {
    const lastArg = args[args.length - 1]!;
    // The renderer passes paths as `file:<path>`.
    const prefix = lastArg.startsWith('file:') ? 'file:' : '';
    const output = lastArg.slice(prefix.length);
    // Only a render to an .mp4 is cached; anything else (audio mix, probes) runs for real.
    if (!output.toLowerCase().endsWith('.mp4')) {
      stats.real += 1;
      return realRun(args, options);
    }
    const hash = createHash('sha256');
    for (const arg of args.slice(0, -1)) {
      const asPath = arg.startsWith('file:') ? arg.slice(5) : arg;
      hash.update((await exists(asPath)) ? `file:${createHash('sha256').update(await readFile(asPath)).digest('hex')}` : `arg:${arg}`);
      hash.update('\0');
    }
    const key = hash.digest('hex');

    let cached = done.get(key);
    let rendered = false;
    if (!cached) {
      let pending = inFlight.get(key);
      if (!pending) {
        pending = (async () => {
          await mkdir(cacheDir, { recursive: true });
          const file = path.join(cacheDir, `render-${(n += 1)}.mp4`);
          stats.real += 1;
          rendered = true;
          await realRun([...args.slice(0, -1), `${prefix}${file}`], options);
          done.set(key, file);
          return file;
        })().finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      cached = await pending;
    }
    if (!rendered) stats.copies += 1;
    await copyFile(cached, output);
  };
  return { run, stats };
}
