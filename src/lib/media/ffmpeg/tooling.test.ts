import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { describeFfmpeg } from '../../../../tests/utils/ffmpeg.js';
import {
  checkFfmpegTooling,
  createFfmpegToolingGuard,
  evaluateTooling,
  FfmpegToolingError,
  HDR_FILTERS,
  parseFeatureNames,
  parseFfmpegVersion,
  REQUIRED_ENCODERS,
  REQUIRED_FILTERS,
  type ToolingSpawnFn,
} from './index.js';

const VERSION = 'ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc 16.2.0\n';
const encoders = (...names: string[]) =>
  ['Encoders:', ' V..... = Video', ' A..... = Audio', ' ------', ...names.map((n) => ` V....D ${n.padEnd(20)} some description`)].join('\n');
const filters = (...names: string[]) =>
  ['Filters:', '  T.. = Timeline support', '  .S. = Slice threading', '  ..C = Command support', '  A = Audio input/output', ' ------', ...names.map((n) => ` T.. ${n.padEnd(16)} V->V       some description`)].join('\n');
const ALL_ENCODERS = [...REQUIRED_ENCODERS];
const ALL_FILTERS = [...REQUIRED_FILTERS];

describe('parsing the output of ffmpeg', () => {
  it('reads the version from the first line', () => {
    expect(parseFfmpegVersion(VERSION)).toBe('9.0.2-full_build-www.gyan.dev');
    expect(parseFfmpegVersion('ffmpeg version N-12345-gabcdef\n')).toBe('N-12345-gabcdef');
    expect(parseFfmpegVersion('something else')).toBeNull();
    expect(parseFfmpegVersion('')).toBeNull();
  });

  it('reads the names of encoders and filters, and skips the legend lines', () => {
    expect([...parseFeatureNames(encoders('libx264', 'aac'))].sort()).toEqual(['aac', 'libx264']);
    expect([...parseFeatureNames(filters('scale', 'zscale', 'concat'))].sort()).toEqual(['concat', 'scale', 'zscale']);
    expect(parseFeatureNames('')).toEqual(new Set());
    expect(parseFeatureNames('garbage line\nnot a table')).toEqual(new Set());
  });
});

describe('evaluateTooling (pure)', () => {
  const ok = { versionOutput: VERSION, encodersOutput: encoders(...ALL_ENCODERS), filtersOutput: filters(...ALL_FILTERS, ...HDR_FILTERS) };

  it('accepts a complete FFmpeg and reports HDR support', () => {
    expect(evaluateTooling(ok)).toEqual({ version: '9.0.2-full_build-www.gyan.dev', hdr: true, missing: [] });
  });

  it('lists exactly what is missing, in a stable order', () => {
    const result = evaluateTooling({ ...ok, encodersOutput: encoders('aac'), filtersOutput: filters(...ALL_FILTERS.filter((f) => f !== 'overlay' && f !== 'fps'), ...HDR_FILTERS) });
    expect(result.missing).toEqual(['libx264', 'overlay', 'fps']);
  });

  it('without zscale or tonemap only HDR is lost', () => {
    for (const keep of [[], ['zscale'], ['tonemap']]) {
      const result = evaluateTooling({ ...ok, filtersOutput: filters(...ALL_FILTERS, ...keep) });
      expect(result.missing).toEqual([]);
      expect(result.hdr).toBe(false);
    }
  });

  it('refuses output it cannot understand', () => {
    expect(() => evaluateTooling({ ...ok, versionOutput: 'hello' })).toThrow(FfmpegToolingError);
    expect(() => evaluateTooling({ ...ok, encodersOutput: '' })).toThrow(/could not be understood/);
    expect(() => evaluateTooling({ ...ok, filtersOutput: 'nothing here' })).toThrow(/could not be understood/);
  });
});

/** A fake child that answers like ffmpeg: stdout, then exit. */
function fakeSpawn(answers: Record<string, string | { code: number }>, record: string[][] = []) {
  const spawn = vi.fn((_command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    record.push([...args]);
    const key = args.includes('-version') ? 'version' : args.includes('-encoders') ? 'encoders' : 'filters';
    const answer = answers[key] ?? '';
    setImmediate(() => {
      child.stderr.write('/home/someone/secret/path: noisy diagnostics');
      if (typeof answer === 'string') {
        child.stdout.write(answer);
        child.emit('close', 0);
      } else child.emit('close', answer.code);
    });
    return child as never;
  });
  return spawn as unknown as ToolingSpawnFn & ReturnType<typeof vi.fn>;
}

describe('checkFfmpegTooling (fake child process)', () => {
  const complete = { version: VERSION, encoders: encoders(...ALL_ENCODERS), filters: filters(...ALL_FILTERS, ...HDR_FILTERS) };

  it('runs three fixed commands with an argument array and no shell, and returns version and HDR support', async () => {
    const calls: string[][] = [];
    const spawn = fakeSpawn(complete, calls);
    await expect(checkFfmpegTooling({ ffmpegPath: 'my-ffmpeg', ffprobePath: 'p', spawn, ffprobeAvailable: () => true })).resolves.toEqual({ version: '9.0.2-full_build-www.gyan.dev', hdr: true });
    expect(calls).toEqual([['-version'], ['-hide_banner', '-encoders'], ['-hide_banner', '-filters']]);
    for (const call of (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toBe('my-ffmpeg');
      expect(call[2]).toEqual({ shell: false, windowsHide: true });
    }
  });

  it('fails with the names that are missing, ffprobe included, and never with FFmpeg output', async () => {
    const spawn = fakeSpawn({ ...complete, encoders: encoders('aac'), filters: filters(...ALL_FILTERS.filter((f) => f !== 'concat')) });
    const error = await checkFfmpegTooling({ ffmpegPath: 'f', ffprobePath: 'p', spawn, ffprobeAvailable: () => false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegToolingError);
    expect((error as FfmpegToolingError).code).toBe('missing');
    expect((error as FfmpegToolingError).missing).toEqual(['libx264', 'concat', 'ffprobe']);
    expect((error as Error).message).toBe('FFmpeg is missing what reel production needs: libx264, concat, ffprobe');
    expect((error as Error).message).not.toContain('secret');
  });

  it('maps a missing executable, a failing exit and an answer nobody can read to fixed codes', async () => {
    const missing = (() => {
      throw new Error('spawn ENOENT C:\\somewhere\\ffmpeg.exe');
    }) as unknown as ToolingSpawnFn;
    await expect(checkFfmpegTooling({ ffmpegPath: 'f', ffprobePath: 'p', spawn: missing })).rejects.toMatchObject({ code: 'not_found', message: 'FFmpeg could not be started: check FFMPEG_PATH' });
    await expect(checkFfmpegTooling({ ffmpegPath: 'f', ffprobePath: 'p', spawn: fakeSpawn({ version: { code: 1 } }) })).rejects.toMatchObject({ code: 'exit_nonzero' });
    await expect(checkFfmpegTooling({ ffmpegPath: 'f', ffprobePath: 'p', spawn: fakeSpawn({ version: 'not ffmpeg' }) })).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('kills a command that does not answer in time', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const spawn = vi.fn(() => child as never) as unknown as ToolingSpawnFn;
    await expect(checkFfmpegTooling({ ffmpegPath: 'f', ffprobePath: 'p', spawn, timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout', message: 'FFmpeg did not answer in time' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('createFfmpegToolingGuard (once per process)', () => {
  const complete = { version: VERSION, encoders: encoders(...ALL_ENCODERS), filters: filters(...ALL_FILTERS) };

  it('checks once and remembers the success', async () => {
    const spawn = fakeSpawn(complete);
    const guard = createFfmpegToolingGuard({ ffmpegPath: 'f', ffprobePath: 'p', spawn, ffprobeAvailable: () => true });
    const [a, b] = await Promise.all([guard(), guard()]);
    expect(a).toEqual({ version: '9.0.2-full_build-www.gyan.dev', hdr: false });
    expect(b).toBe(a);
    await guard();
    expect(spawn).toHaveBeenCalledTimes(3); // version, encoders, filters: only the first time
  });

  it('does not remember a failure, so installing FFmpeg needs no restart', async () => {
    let installed = false;
    const guard = createFfmpegToolingGuard({
      ffmpegPath: 'f',
      ffprobePath: 'p',
      spawn: ((...args: Parameters<ToolingSpawnFn>) => fakeSpawn(installed ? complete : { ...complete, encoders: encoders('aac') })(...args)) as ToolingSpawnFn,
      ffprobeAvailable: () => true,
    });
    await expect(guard()).rejects.toMatchObject({ code: 'missing', missing: ['libx264'] });
    installed = true;
    await expect(guard()).resolves.toMatchObject({ version: '9.0.2-full_build-www.gyan.dev' });
  });
});

describeFfmpeg('checkFfmpegTooling (the real FFmpeg on this machine)', () => {
  it('finds everything reel production needs', async () => {
    const tooling = await checkFfmpegTooling({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    expect(tooling.version).toMatch(/^\S+$/);
    expect(typeof tooling.hdr).toBe('boolean');
  });
});
