import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../config/index.js';
import { FakeMediaProbe } from './fakeMediaProbe.js';
import { FfprobeMediaProbe, type SpawnFn } from './ffprobeMediaProbe.js';
import { parseFfprobeOutput } from './parseFfprobe.js';
import { MediaProbeError } from './types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'media');
const recorded = (name: string) => readFileSync(path.join(FIXTURES, 'ffprobe', `${name}.json`), 'utf8');

describe('parseFfprobeOutput (recorded real ffprobe output)', () => {
  it('reads a JPEG photo', () => {
    expect(parseFfprobeOutput(recorded('sample.jpg'))).toEqual({
      kind: 'foto', format: 'jpeg_pipe', mime: 'image/jpeg', width: 64, height: 48, durationMs: null,
    });
  });

  it('reads a PNG photo', () => {
    expect(parseFfprobeOutput(recorded('sample.png'))).toEqual({
      kind: 'foto', format: 'png_pipe', mime: 'image/png', width: 32, height: 24, durationMs: null,
    });
  });

  it('reads a WebP photo', () => {
    expect(parseFfprobeOutput(recorded('sample.webp'))).toEqual({
      kind: 'foto', format: 'webp_pipe', mime: 'image/webp', width: 48, height: 48, durationMs: null,
    });
  });

  it('reads an MP4 video with its duration in milliseconds', () => {
    expect(parseFfprobeOutput(recorded('sample.mp4'))).toEqual({
      kind: 'video', format: 'mov,mp4,m4a,3gp,3g2,mj2', mime: 'video/mp4', width: 64, height: 48, durationMs: 1000,
    });
  });

  it('reads a QuickTime video rotated by 90 degrees: displayed size is swapped', () => {
    expect(parseFfprobeOutput(recorded('rotated.mov'))).toEqual({
      kind: 'video', format: 'mov,mp4,m4a,3gp,3g2,mj2', mime: 'video/quicktime', width: 48, height: 64, durationMs: 1000,
    });
  });

  it('swaps for -90 and 270 as well, and not for 0 or 180', () => {
    const base = JSON.parse(recorded('sample.mp4'));
    for (const [rotation, swapped] of [[0, false], [180, false], [-90, true], [270, true], [90, true]] as const) {
      base.streams[0].side_data_list = [{ side_data_type: 'Display Matrix', rotation }];
      const result = parseFfprobeOutput(JSON.stringify(base));
      expect([result.width, result.height]).toEqual(swapped ? [48, 64] : [64, 48]);
    }
    delete base.streams[0].side_data_list;
    base.streams[0].tags = { rotate: '90' };
    expect(parseFfprobeOutput(JSON.stringify(base))).toMatchObject({ width: 48, height: 64 });
  });

  it('rejects garbage, empty output, missing streams, audio-only files and unknown formats', () => {
    const base = JSON.parse(recorded('sample.mp4'));
    const audioOnly = structuredClone(base);
    audioOnly.streams[0].codec_type = 'audio';
    const unknownFormat = structuredClone(base);
    unknownFormat.format.format_name = 'matroska,webm';
    const noDimensions = structuredClone(base);
    delete noDimensions.streams[0].width;
    const unknownCodec = JSON.parse(recorded('sample.jpg'));
    unknownCodec.streams[0].codec_name = 'bmp';
    const noDuration = structuredClone(base);
    delete noDuration.streams[0].duration;
    delete noDuration.format.duration;
    for (const bad of ['', 'not json', '[]', '{}', '{"streams":[],"format":{}}', JSON.stringify(audioOnly), JSON.stringify(unknownFormat), JSON.stringify(noDimensions), JSON.stringify(unknownCodec), JSON.stringify(noDuration)]) {
      expect(() => parseFfprobeOutput(bad)).toThrow(MediaProbeError);
      try {
        parseFfprobeOutput(bad);
      } catch (error) {
        expect(error).toMatchObject({ code: 'parse' });
      }
    }
  });

  it('ignores fields it does not need', () => {
    const noisy = JSON.parse(recorded('sample.png'));
    noisy.format.tags = { anything: 'x' };
    noisy.extra = { whatever: [1, 2, 3] };
    expect(parseFfprobeOutput(JSON.stringify(noisy)).kind).toBe('foto');
  });
});

/** A fake child process: stdout/stderr streams, an exit event and a kill spy. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function probeWith(child: ReturnType<typeof fakeChild>, timeoutMs = 1000) {
  const spawn = vi.fn(() => child as never) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
  return { spawn, probe: new FfprobeMediaProbe({ path: 'my-ffprobe', timeoutMs, spawn }) };
}

describe('FfprobeMediaProbe (fake child process)', () => {
  it('runs ffprobe with an argument array, no shell, and an absolute file: path', async () => {
    const child = fakeChild();
    const { probe, spawn } = probeWith(child);
    const pending = probe.probe('relative/photo.jpg');
    child.stdout.write(recorded('sample.jpg'));
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ kind: 'foto', width: 64 });
    const [command, args, options] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe('my-ffprobe');
    expect(args).toEqual(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', `file:${path.resolve('relative/photo.jpg')}`]);
    expect(options.shell).toBe(false);
  });

  it('a file name starting with "-" or looking like a protocol cannot become an option or a protocol', async () => {
    for (const hostile of ['-i', '--help', 'concat:a|b', 'http://example.test/x.jpg']) {
      const child = fakeChild();
      const { probe, spawn } = probeWith(child);
      const pending = probe.probe(hostile);
      child.stdout.write(recorded('sample.jpg'));
      child.emit('close', 0);
      await pending;
      const args = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
      const target = args.at(-1)!;
      expect(target.startsWith('file:')).toBe(true);
      expect(path.isAbsolute(target.slice('file:'.length))).toBe(true);
      expect(args.filter((a) => a.startsWith('-'))).toEqual(['-v', '-print_format', '-show_format', '-show_streams']);
    }
  });

  it('times out: kills the process and throws a timeout error', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const { probe } = probeWith(child, 500);
      const pending = probe.probe('a.jpg');
      const assertion = expect(pending).rejects.toMatchObject({ name: 'MediaProbeError', code: 'timeout' });
      await vi.advanceTimersByTimeAsync(501);
      await assertion;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a non-zero exit code, without any stderr text in the message', async () => {
    const child = fakeChild();
    const { probe } = probeWith(child);
    const pending = probe.probe('a.jpg');
    child.stderr.write('SECRET-STDERR-MARKER /home/someone/private/photo.jpg: Invalid data found');
    child.emit('close', 1);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaProbeError);
    expect(error).toMatchObject({ code: 'exit_nonzero', exitCode: 1 });
    expect((error as Error).message).toBe('ffprobe failed with exit code 1');
    expect(JSON.stringify(error) + String(error) + (error as Error).stack?.split('\n')[0]).not.toContain('SECRET-STDERR-MARKER');
  });

  it('maps a missing executable to not_found', async () => {
    const child = fakeChild();
    const { probe } = probeWith(child);
    const pending = probe.probe('a.jpg');
    child.emit('error', Object.assign(new Error('spawn my-ffprobe ENOENT'), { code: 'ENOENT' }));
    await expect(pending).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps a spawn that throws to not_found', async () => {
    const spawn = (() => {
      throw new Error('boom');
    }) as unknown as SpawnFn;
    await expect(new FfprobeMediaProbe({ path: 'x', timeoutMs: 100, spawn }).probe('a.jpg')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects oversized output and kills the process', async () => {
    const child = fakeChild();
    const { probe } = probeWith(child);
    const pending = probe.probe('a.jpg');
    child.stdout.write(Buffer.alloc(1_000_001, 0x20));
    await expect(pending).rejects.toMatchObject({ code: 'output_too_large' });
    expect(child.kill).toHaveBeenCalled();
  });

  it('maps unreadable output of a successful run to a parse error', async () => {
    const child = fakeChild();
    const { probe } = probeWith(child);
    const pending = probe.probe('a.jpg');
    child.stdout.write('not json');
    child.emit('close', 0);
    await expect(pending).rejects.toMatchObject({ code: 'parse' });
  });
});

describe('FakeMediaProbe', () => {
  it('answers from a queue and records calls', async () => {
    const result = { kind: 'foto', format: 'png_pipe', mime: 'image/png', width: 1, height: 1, durationMs: null } as const;
    const probe = new FakeMediaProbe().enqueue(result, { error: new MediaProbeError('timeout') });
    await expect(probe.probe('/a')).resolves.toEqual(result);
    await expect(probe.probe('/b')).rejects.toMatchObject({ code: 'timeout' });
    await expect(probe.probe('/c')).rejects.toThrow(/no scripted answer/);
    expect(probe.calls).toEqual(['/a', '/b', '/c']);
  });
});

describe('media config', () => {
  const base = {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    LOG_LEVEL: 'info',
    LOCAL_STORAGE_SIGNING_SECRET: 'x'.repeat(32),
    SECRETS_KEYS: `1:${Buffer.alloc(32, 1).toString('base64')}`,
    SECRETS_ACTIVE_KEY_VERSION: '1',
  };

  it('has defaults: ffprobe on the PATH, 15 s, 200 MiB', () => {
    expect(loadConfig(base).media).toEqual({ ffprobePath: 'ffprobe', ffprobeTimeoutMs: 15_000, maxBytes: 209_715_200 });
    expect(loadConfig({ ...base, FFPROBE_PATH: '', FFPROBE_TIMEOUT_MS: '', MEDIA_MAX_BYTES: '' }).media.maxBytes).toBe(209_715_200);
  });

  it('accepts overrides and rejects out-of-range values', () => {
    expect(loadConfig({ ...base, FFPROBE_PATH: 'C:\\tools\\ffprobe.exe', FFPROBE_TIMEOUT_MS: '5000', MEDIA_MAX_BYTES: '10485760' }).media).toEqual({
      ffprobePath: 'C:\\tools\\ffprobe.exe', ffprobeTimeoutMs: 5000, maxBytes: 10_485_760,
    });
    for (const [name, bad] of [['FFPROBE_TIMEOUT_MS', '999'], ['FFPROBE_TIMEOUT_MS', '120001'], ['FFPROBE_TIMEOUT_MS', 'abc'], ['MEDIA_MAX_BYTES', '1048575'], ['MEDIA_MAX_BYTES', '2147483649'], ['MEDIA_MAX_BYTES', '1.5']] as const) {
      expect(() => loadConfig({ ...base, [name]: bad })).toThrow(new RegExp(name));
    }
  });
});

// Optional: runs the REAL ffprobe on a committed fixture. Skipped automatically when ffprobe is not on the PATH.
const ffprobeOnPath = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!ffprobeOnPath)('real ffprobe (optional integration)', () => {
  const real = new FfprobeMediaProbe({ path: 'ffprobe', timeoutMs: 15_000 });

  it.each([
    ['sample.jpg', { kind: 'foto', mime: 'image/jpeg', width: 64, height: 48, durationMs: null }],
    ['sample.png', { kind: 'foto', mime: 'image/png', width: 32, height: 24, durationMs: null }],
    ['sample.webp', { kind: 'foto', mime: 'image/webp', width: 48, height: 48, durationMs: null }],
    ['sample.mp4', { kind: 'video', mime: 'video/mp4', width: 64, height: 48, durationMs: 1000 }],
    ['rotated.mov', { kind: 'video', mime: 'video/quicktime', width: 48, height: 64, durationMs: 1000 }],
  ])('probes %s', async (file, expected) => {
    await expect(real.probe(path.join(FIXTURES, file))).resolves.toMatchObject(expected);
  });

  it('fails with a typed error on a file that is not media', async () => {
    await expect(real.probe(path.join(FIXTURES, 'disallowed', 'page.html.jpg'))).rejects.toBeInstanceOf(MediaProbeError);
  });
});
