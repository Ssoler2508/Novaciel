import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeFfmpeg } from '../../../../tests/utils/ffmpeg.js';
import { patternClip, rotatedQuadrantsClip } from '../../../../tests/utils/ffmpegClips.js';
import { MediaProbeError } from '../probe/types.js';
import { collectNested, inspectMp4, parseBoxList } from './mp4Boxes.js';
import { parseFrameRate, parseVideoFacts } from './parseVideoFacts.js';
import { probeVideo, type ProbeSpawnFn } from './probeVideo.js';

const json = (value: unknown) => JSON.stringify(value);
const VIDEO = { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1080, height: 1920, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1', nb_frames: '450', duration: '15.000000', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709', color_range: 'tv', tags: { language: 'und', handler_name: 'VideoHandler' } };
const AUDIO = { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '15.010667', tags: { language: 'und', handler_name: 'SoundHandler' } };
const FORMAT = { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '15.000000', size: '9000000', tags: { major_brand: 'isom', minor_version: '512' } };

describe('parseVideoFacts', () => {
  it('reads the video, the audio, the tags and the format', () => {
    const facts = parseVideoFacts(json({ streams: [VIDEO, AUDIO], format: FORMAT }));
    expect(facts).toEqual({
      formato: 'mov,mp4,m4a,3gp,3g2,mj2',
      duracionMs: 15_000,
      tamanoBytes: 9_000_000,
      video: {
        ancho: 1080, alto: 1920, codec: 'h264', perfil: 'High', pixFmt: 'yuv420p', rFrameRate: '30/1', avgFrameRate: '30/1', fps: 30, nbFrames: 450,
        duracionMs: 15_000, hdr: false, colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709', colorRange: 'tv',
      },
      audio: { codec: 'aac', sampleRate: 48_000, channels: 2, duracionMs: 15_011 },
      streams: [
        { tipo: 'video', tags: { language: 'und', handler_name: 'VideoHandler' } },
        { tipo: 'audio', tags: { language: 'und', handler_name: 'SoundHandler' } },
      ],
      tagsFormato: { major_brand: 'isom', minor_version: '512' },
    });
  });

  it('swaps the size of a stream rotated by 90 or 270 degrees, from the display matrix or the legacy tag', () => {
    const rotated = (extra: object) => parseVideoFacts(json({ streams: [{ ...VIDEO, width: 1920, height: 1080, ...extra }], format: FORMAT })).video!;
    for (const rotation of [90, -90, 270]) expect([rotated({ side_data_list: [{ side_data_type: 'Display Matrix', rotation }] }).ancho, rotated({ side_data_list: [{ rotation }] }).alto]).toEqual([1080, 1920]);
    expect(rotated({ side_data_list: [{ rotation: 180 }] })).toMatchObject({ ancho: 1920, alto: 1080 });
    expect(rotated({ tags: { rotate: '90' } })).toMatchObject({ ancho: 1080, alto: 1920 });
    expect(rotated({})).toMatchObject({ ancho: 1920, alto: 1080 });
  });

  it('flags HDR by the transfer function (PQ and HLG), not SDR', () => {
    const hdr = (color_transfer: string) => parseVideoFacts(json({ streams: [{ ...VIDEO, color_transfer }], format: FORMAT })).video!.hdr;
    expect([hdr('smpte2084'), hdr('arib-std-b67'), hdr('bt709'), hdr('unknown')]).toEqual([true, true, false, false]);
  });

  it('parses frame rates and treats the unknown ones as null', () => {
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    for (const bad of ['0/0', '30/0', '0/1', 'abc', '', undefined, '30']) expect(parseFrameRate(bad), String(bad)).toBeNull();
    expect(parseVideoFacts(json({ streams: [{ ...VIDEO, avg_frame_rate: '0/0' }], format: FORMAT })).video!.fps).toBe(30); // falls back to r_frame_rate
  });

  it('copes with a file with no audio, no video, missing numbers and tags that are not strings', () => {
    expect(parseVideoFacts(json({ streams: [VIDEO], format: FORMAT })).audio).toBeNull();
    expect(parseVideoFacts(json({ streams: [AUDIO], format: FORMAT })).video).toBeNull();
    const sparse = parseVideoFacts(json({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 10, height: 10, nb_frames: 'N/A', duration: 'N/A', tags: { n: 5, o: { a: 1 } } }], format: {} }));
    expect(sparse.video).toMatchObject({ nbFrames: null, duracionMs: null, perfil: null, fps: null });
    expect(sparse.duracionMs).toBeNull();
    expect(sparse.streams[0]!.tags).toEqual({ n: '5', o: '{"a":1}' });
  });

  it('throws a parse error for anything unreadable', () => {
    for (const bad of ['', 'not json', '[]', '{"streams": "x"}', json({ streams: [{ codec_type: 'video', width: 0, height: 5, codec_name: 'h264' }] }), json({ streams: [{ codec_type: 'video', codec_name: 'h264' }] })]) {
      expect(() => parseVideoFacts(bad), bad).toThrow(MediaProbeError);
    }
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe('probeVideo (fake child process)', () => {
  const run = (child: ReturnType<typeof fakeChild>, timeoutMs = 1000) => {
    const spawn = vi.fn(() => child as never) as unknown as ProbeSpawnFn & ReturnType<typeof vi.fn>;
    return { spawn, promise: probeVideo(path.join('relative', '-weird name ñá.mp4'), { ffprobePath: 'my-ffprobe', timeoutMs, spawn }) };
  };

  it('runs ffprobe with an array, no shell and an absolute file: path, and returns the facts', async () => {
    const child = fakeChild();
    const { spawn, promise } = run(child);
    child.stdout.write(json({ streams: [VIDEO, AUDIO], format: FORMAT }));
    child.emit('close', 0);
    expect((await promise).video!.ancho).toBe(1080);
    const [command, args, options] = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe('my-ffprobe');
    expect(options).toEqual({ shell: false, windowsHide: true });
    expect(args.slice(0, 6)).toEqual(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams']);
    expect(args.at(-1)).toBe(`file:${path.resolve('relative', '-weird name ñá.mp4')}`);
  });

  it('maps a failing exit, a bad answer, a missing executable and a timeout to fixed errors, never showing stderr', async () => {
    const failing = fakeChild();
    const a = run(failing);
    failing.stderr.write('C:\\private\\secret.mp4: Invalid data');
    failing.emit('close', 1);
    const error = (await a.promise.catch((e: unknown) => e)) as MediaProbeError;
    expect([error.code, error.exitCode, error.message.includes('secret')]).toEqual(['exit_nonzero', 1, false]);

    const garbled = fakeChild();
    const b = run(garbled);
    garbled.stdout.write('no json here');
    garbled.emit('close', 0);
    await expect(b.promise).rejects.toMatchObject({ code: 'parse' });

    const missing = fakeChild();
    const c = run(missing);
    missing.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(c.promise).rejects.toMatchObject({ code: 'not_found' });

    const slow = fakeChild();
    const d = run(slow, 30);
    await expect(d.promise).rejects.toMatchObject({ code: 'timeout' });
    expect(slow.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

/** A box: 4-byte size, 4-byte type, payload. */
const box = (type: string, ...children: Buffer[]): Buffer => {
  const payload = Buffer.concat(children);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
};
const fullBox = (type: string, ...children: Buffer[]) => box(type, Buffer.alloc(4), ...children);
const emptyUdta = () => box('udta', fullBox('meta', fullBox('hdlr', Buffer.alloc(21)), box('ilst')));

describe('mp4Boxes', () => {
  it('lists the boxes of a buffer, with sizes and header lengths', () => {
    const file = Buffer.concat([box('ftyp', Buffer.alloc(24)), box('moov', box('mvhd', Buffer.alloc(100))), box('mdat', Buffer.alloc(50))]);
    expect(parseBoxList(file).map((b) => [b.tipo, b.offset, b.tamano, b.cabecera])).toEqual([['ftyp', 0, 32, 8], ['moov', 32, 116, 8], ['mdat', 148, 58, 8]]);
  });

  it('reads a 64-bit size, a box that runs to the end (size 0) and stops at a malformed header', () => {
    const large = Buffer.alloc(16 + 4);
    large.writeUInt32BE(1, 0);
    large.write('mdat', 4, 'latin1');
    large.writeBigUInt64BE(20n, 8);
    expect(parseBoxList(large).map((b) => [b.tipo, b.tamano, b.cabecera])).toEqual([['mdat', 20, 16]]);

    const toEnd = Buffer.concat([box('ftyp'), Buffer.from([0, 0, 0, 0]), Buffer.from('mdat', 'latin1'), Buffer.alloc(30)]);
    expect(parseBoxList(toEnd).map((b) => [b.tipo, b.tamano])).toEqual([['ftyp', 8], ['mdat', 38]]);

    const tooBig = Buffer.concat([box('ftyp'), (() => { const h = Buffer.alloc(8); h.writeUInt32BE(1000, 0); h.write('moov', 4, 'latin1'); return h; })()]);
    expect(parseBoxList(tooBig).map((b) => b.tipo)).toEqual(['ftyp']);
    const tooSmall = Buffer.alloc(8);
    tooSmall.writeUInt32BE(4, 0);
    expect(parseBoxList(tooSmall)).toEqual([]);
    expect(parseBoxList(Buffer.alloc(3))).toEqual([]);
  });

  it('lists the boxes inside moov with their path, opening meta after its four version bytes', () => {
    const moov = box('moov', box('mvhd', Buffer.alloc(10)), box('trak', box('tkhd', Buffer.alloc(10)), box('mdia', box('minf', box('stbl', box('stsd'))))), emptyUdta());
    const [root] = parseBoxList(moov);
    expect(collectNested(moov, root!).map((b) => b.ruta)).toEqual([
      'mvhd', 'trak', 'trak/tkhd', 'trak/mdia', 'trak/mdia/minf', 'trak/mdia/minf/stbl', 'udta', 'udta/meta', 'udta/meta/hdlr', 'udta/meta/ilst',
    ]);
    expect(collectNested(moov, root!).find((b) => b.ruta === 'udta/meta/ilst')!.tamano).toBe(8);
  });

  describe('inspectMp4 (a file on disk)', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'novaciel-boxes-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('reports the top-level order and the contents of moov', async () => {
      const faststart = path.join(dir, 'fast ñá.mp4');
      await writeFile(faststart, Buffer.concat([box('ftyp', Buffer.alloc(16)), box('moov', box('mvhd', Buffer.alloc(10)), emptyUdta()), box('free'), box('mdat', Buffer.alloc(5000))]));
      expect(await inspectMp4(faststart)).toMatchObject({ superiores: ['ftyp', 'moov', 'free', 'mdat'], moovDemasiadoGrande: false });
      expect((await inspectMp4(faststart)).dentroDeMoov.map((b) => b.ruta)).toContain('udta/meta/ilst');

      const slow = path.join(dir, 'slow.mp4');
      await writeFile(slow, Buffer.concat([box('ftyp', Buffer.alloc(16)), box('mdat', Buffer.alloc(5000)), box('moov', box('mvhd', Buffer.alloc(10)))]));
      expect((await inspectMp4(slow)).superiores).toEqual(['ftyp', 'mdat', 'moov']);
    });

    it('does not read a moov that is too big, and survives a truncated or empty file', async () => {
      const big = path.join(dir, 'big.mp4');
      const header = Buffer.alloc(8);
      header.writeUInt32BE(20 * 1024 * 1024, 0);
      header.write('moov', 4, 'latin1');
      await writeFile(big, Buffer.concat([box('ftyp'), header, Buffer.alloc(20 * 1024 * 1024 - 8)]));
      expect(await inspectMp4(big)).toMatchObject({ superiores: ['ftyp', 'moov'], moovDemasiadoGrande: true, dentroDeMoov: [] });

      const truncated = path.join(dir, 'truncated.mp4');
      await writeFile(truncated, Buffer.concat([box('ftyp'), header, Buffer.alloc(100)]));
      expect((await inspectMp4(truncated)).superiores).toEqual(['ftyp']);
      const empty = path.join(dir, 'empty.mp4');
      await writeFile(empty, Buffer.alloc(0));
      expect(await inspectMp4(empty)).toEqual({ superiores: [], dentroDeMoov: [], moovDemasiadoGrande: false });
    });
  });
});

describeFfmpeg('probeVideo (the real ffprobe)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'prueba sonda ñá '));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a clip in a folder with a space and an accent, and the displayed size of a rotated one', async () => {
    const clip = patternClip(dir, 'clip ñá.mp4', { seconds: 2, fps: 25 });
    const facts = await probeVideo(clip, { ffprobePath: 'ffprobe', timeoutMs: 15_000 });
    expect(facts.video).toMatchObject({ ancho: 720, alto: 1280, codec: 'h264', pixFmt: 'yuv420p', fps: 25, hdr: false });
    expect(facts.duracionMs).toBeGreaterThan(1900);
    expect(facts.audio).toBeNull();

    const rotated = rotatedQuadrantsClip(dir, 'rotado.mp4', 90, { seconds: 2 });
    expect(await probeVideo(rotated, { ffprobePath: 'ffprobe', timeoutMs: 15_000 })).toMatchObject({ video: { ancho: 810, alto: 1440 } });
  });

  it('fails with a typed error for a file that is not a video', async () => {
    const bad = path.join(dir, 'bad.mp4');
    await writeFile(bad, Buffer.from('this is not a video'));
    await expect(probeVideo(bad, { ffprobePath: 'ffprobe', timeoutMs: 15_000 })).rejects.toBeInstanceOf(MediaProbeError);
  });
});
