import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { describeFfmpeg } from '../../../../tests/utils/ffmpeg.js';
import { classifyFfmpegStderr, FfmpegRunError, runFfmpeg, type RunSpawnFn } from './runFfmpeg.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}
const spawnOf = (child: ReturnType<typeof fakeChild>) => vi.fn(() => child as never) as unknown as RunSpawnFn & ReturnType<typeof vi.fn>;

const SECRET_PATH = 'C:\\Users\\someone\\private clips\\birthday.mp4';

describe('classifyFfmpegStderr', () => {
  it.each([
    ['fuente_danada', `${SECRET_PATH}: Invalid data found when processing input`],
    ['fuente_danada', '[mov,mp4,m4a,3gp,3g2,mj2 @ 000001] moov atom not found'],
    ['fuente_danada', 'Error opening input file x.mp4.'],
    ['filtro', 'Error initializing filters\nError reinitializing filters!'],
    ['filtro', "No such filter: 'zscale'"],
    ['filtro', 'Error while filtering: Generic error in an external library'],
    ['codificador', 'Error while opening encoder for output stream #0:0'],
    ['codificador', 'Unknown encoder libx264'],
    ['disco_lleno', 'av_interleaved_write_frame(): No space left on device'],
    ['desconocido', 'something nobody planned for'],
    ['desconocido', ''],
  ] as const)('%s <- %s', (expected, stderr) => {
    expect(classifyFfmpegStderr(stderr)).toBe(expected);
  });
});

describe('runFfmpeg (fake child process)', () => {
  it('spawns with an argument array, no shell, and resolves on exit 0', async () => {
    const child = fakeChild();
    const spawn = spawnOf(child);
    const promise = runFfmpeg(['-i', 'file:/x', '-y', 'file:/y'], { ffmpegPath: 'my-ffmpeg', timeoutMs: 1000, spawn });
    child.stdout.write('progress noise');
    child.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(command).toBe('my-ffmpeg');
    expect(args).toEqual(['-i', 'file:/x', '-y', 'file:/y']);
    expect(options).toEqual({ shell: false, windowsHide: true });
  });

  it('maps a failing exit to a fixed category and never shows stderr', async () => {
    for (const [stderr, categoria] of [
      [`${SECRET_PATH}: Invalid data found when processing input`, 'fuente_danada'],
      ['Error initializing filters', 'filtro'],
      ['title=Mi cumpleaños 2024', 'desconocido'],
    ] as const) {
      const child = fakeChild();
      const promise = runFfmpeg(['-i', 'x'], { ffmpegPath: 'f', timeoutMs: 1000, spawn: spawnOf(child) });
      child.stderr.write(stderr);
      child.emit('close', 1);
      const error = (await promise.catch((e: unknown) => e)) as FfmpegRunError;
      expect(error).toBeInstanceOf(FfmpegRunError);
      expect(error.categoria).toBe(categoria);
      expect(error.exitCode).toBe(1);
      expect(error.message).toMatch(/\(exit code 1\)$/);
      expect(error.message).not.toContain('private');
      expect(error.message).not.toContain('cumplea');
      expect(JSON.stringify(error)).not.toContain('private');
    }
  });

  it('keeps at most 64 KB of stderr and still classifies a message that arrived early', async () => {
    const child = fakeChild();
    const promise = runFfmpeg(['-i', 'x'], { ffmpegPath: 'f', timeoutMs: 1000, spawn: spawnOf(child) });
    child.stderr.write('Invalid data found when processing input\n');
    child.stderr.write(Buffer.alloc(5_000_000, 65));
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ categoria: 'fuente_danada' });
  });

  it('kills the process on timeout and rejects only once it is gone', async () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit('close', null), 30); // the process takes a moment to disappear
    });
    const started = Date.now();
    const promise = runFfmpeg(['-i', 'x'], { ffmpegPath: 'f', timeoutMs: 40, spawn: spawnOf(child) });
    await expect(promise).rejects.toMatchObject({ categoria: 'timeout', message: 'FFmpeg timed out and was stopped' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(Date.now() - started).toBeGreaterThanOrEqual(65);
  });

  it('maps a missing executable and a spawn that throws to no_encontrado', async () => {
    const child = fakeChild();
    const promise = runFfmpeg(['-i', 'x'], { ffmpegPath: 'nope', timeoutMs: 1000, spawn: spawnOf(child) });
    child.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }));
    await expect(promise).rejects.toMatchObject({ categoria: 'no_encontrado' });

    const throwing = (() => {
      throw new Error('boom C:\\secret');
    }) as unknown as RunSpawnFn;
    const error = (await runFfmpeg(['-i', 'x'], { ffmpegPath: 'f', timeoutMs: 1000, spawn: throwing }).catch((e: unknown) => e)) as FfmpegRunError;
    expect(error.categoria).toBe('no_encontrado');
    expect(error.message).not.toContain('secret');
  });
});

describeFfmpeg('runFfmpeg (the real FFmpeg)', () => {
  it('runs a short job, and fails with a category on a bad input', async () => {
    await expect(runFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:d=0.2', '-f', 'null', '-'], { ffmpegPath: 'ffmpeg', timeoutMs: 20_000 })).resolves.toBeUndefined();
    const error = (await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', 'file:does-not-exist.mp4', '-f', 'null', '-'], { ffmpegPath: 'ffmpeg', timeoutMs: 20_000 }).catch((e: unknown) => e)) as FfmpegRunError;
    expect(error).toBeInstanceOf(FfmpegRunError);
    expect(error.categoria).toBe('fuente_danada');
    expect(error.exitCode).toBeGreaterThan(0);
  });

  it('kills a job that runs too long', async () => {
    const started = Date.now();
    await expect(
      runFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60', '-t', '3600', '-f', 'null', '-'], { ffmpegPath: 'ffmpeg', timeoutMs: 700 }),
    ).rejects.toMatchObject({ categoria: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('reports a missing executable', async () => {
    await expect(runFfmpeg(['-version'], { ffmpegPath: 'definitely-not-ffmpeg-7781', timeoutMs: 5000 })).rejects.toMatchObject({ categoria: 'no_encontrado' });
  });
});
