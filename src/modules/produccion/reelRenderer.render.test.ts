import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { framePng, hdrClip, PATTERN_COLORS, patternClip, remux, rotatedQuadrantsClip, solidClip, taggedClip, UPRIGHT_PATTERN, variableFrameRateClip } from '../../../tests/utils/ffmpegClips.js';
import { describeFfmpeg } from '../../../tests/utils/ffmpeg.js';
import { inspectMp4 } from '../../lib/media/ffmpeg/mp4Boxes.js';
import { probeVideo } from '../../lib/media/ffmpeg/probeVideo.js';
import { FfmpegRunError } from '../../lib/media/ffmpeg/runFfmpeg.js';
import { createFfmpegToolingGuard, FfmpegToolingError } from '../../lib/media/ffmpeg/tooling.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import {
  FuenteDeVideoIlegibleError,
  FuentesMuyPequenasError,
  HdrNoSoportadoError,
  SalidaInvalidaError,
  TextDoesNotFitError,
  UnsupportedGlyphsError,
} from './errors.js';
import { renderReel, type ReelRenderDeps, type ReelRenderInput, type ReelRenderResult } from './reelRenderer.js';
import type { ReelGuionInput } from './reelTimeline.js';
import { verifyReelOutput } from './reelVerify.js';

// Real FFmpeg: sources are made with lavfi test sources at test time. The temporary folder of the
// whole file has a SPACE and an ACCENTED character in its path (and backslashes on Windows), so every
// `file:<path>` of every input, overlay and output is exercised with such a path.

const FAST = { preset: 'veryfast' } as const;
const KIT = {};
const TEXT = 'Hola desde la cafetería';

let root: string;
let clips: string;
let tempRoot: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'prueba reel ñá '));
  clips = path.join(root, 'clips ñá');
  tempRoot = path.join(root, 'trabajo ñá');
  await mkdir(clips, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const sceneGuion = (scenes: { media: string; text?: string; dur?: number; entrada?: number; salida?: number }[]): ReelGuionInput => ({
  contenido: { escenas: scenes.map((s, i) => ({ orden: i + 1, texto_en_pantalla: s.text ?? '', duracion_s: s.dur ?? 5 })) },
  tomas: scenes.map((s, i) => ({ orden: i + 1, fuente: 'media_real' as const, media_id: s.media, entrada_ms: s.entrada ?? null, salida_ms: s.salida ?? null })),
});

async function storageWith(files: Record<string, string>): Promise<{ storage: FakeStorage; fuentes: Record<string, string> }> {
  const storage = new FakeStorage();
  const fuentes: Record<string, string> = {};
  for (const [id, file] of Object.entries(files)) {
    fuentes[id] = `cliente/media/${id}.mp4`;
    await storage.put(fuentes[id], await readFile(file));
  }
  return { storage, fuentes };
}

const toolingOk = async () => ({ version: 'test', hdr: true });
const depsFor = (storage: FakeStorage, extra: Partial<ReelRenderDeps> = {}): ReelRenderDeps => ({
  storage,
  tooling: toolingOk,
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  ffmpegTimeoutMs: 180_000,
  ffprobeTimeoutMs: 15_000,
  tempRoot,
  ...extra,
});
const leftovers = async () => (await readdir(tempRoot)).filter((name) => name.startsWith('novaciel-reel-'));
const sha256Of = async (file: string) => createHash('sha256').update(await readFile(file)).digest();

async function pixel(png: string, x: number, y: number): Promise<[number, number, number]> {
  const data = await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  return [data[0]!, data[1]!, data[2]!];
}
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** Renders and returns whatever `inspect` returns while the file exists. */
async function render(input: ReelRenderInput, deps: ReelRenderDeps, inspect: (r: ReelRenderResult) => Promise<unknown> = async () => undefined) {
  return renderReel(deps, input, async (result) => ({ result: { ...result, facts: result.facts, timeline: result.timeline }, extra: await inspect(result) }));
}

describeFfmpeg('renderReel (real FFmpeg)', () => {
  it('renders a verified 1080x1920 reel: format, frames, audio, hash, overlays only where the text is, temp folder gone', async () => {
    const files = { a: solidClip(clips, 'a.mp4', 'cc3333'), b: solidClip(clips, 'b.mp4', '33aa44'), c: solidClip(clips, 'c.mp4', '3355cc') };
    const { storage, fuentes } = await storageWith(files);
    const input: ReelRenderInput = { guion: sceneGuion([{ media: 'a', text: TEXT }, { media: 'b' }, { media: 'c', text: TEXT }]), fuentes, kitVisual: KIT, outputSpec: FAST };

    let ruta = '';
    const { result } = await render(input, depsFor(storage), async (r) => {
      ruta = r.ruta;
      expect(r.ruta).toContain('ñá'); // the path had a space, an accent and (on Windows) backslashes
      expect(r.ruta).toContain(' ');
      const frames: Record<number, string> = {};
      for (const [escena, t] of [[1, 2.5], [2, 7.5], [3, 12.5]] as const) frames[escena] = framePng(r.ruta, t, path.join(root, `frame-${escena}.png`));
      // The scrim band sits at the bottom of the safe zone (y 1580). At the left edge there is no text,
      // only the band (when there is text); the same frame higher up is the clip.
      const band = async (escena: number) => distance(await pixel(frames[escena]!, 10, 1575), await pixel(frames[escena]!, 10, 1000));
      expect(await band(1)).toBeGreaterThan(60);
      expect(await band(2)).toBeLessThan(12);
      expect(await band(3)).toBeGreaterThan(60);
    });

    const { facts, timeline } = result;
    expect(facts.video).toMatchObject({ ancho: 1080, alto: 1920, codec: 'h264', perfil: 'High', pixFmt: 'yuv420p', rFrameRate: '30/1', avgFrameRate: '30/1', nbFrames: 450 });
    expect(facts.audio).toMatchObject({ codec: 'aac', sampleRate: 48_000, channels: 2 });
    expect(Math.abs(facts.duracionMs! - timeline.totalMs)).toBeLessThanOrEqual(100);
    expect(timeline.totalFrames).toBe(450);
    expect(result.tamano).toBeGreaterThan(0);
    expect(ruta).not.toBe('');
    // The file and the folder are gone once the callback returned.
    await expect(stat(ruta)).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  }, 120_000);

  it('hashes the file it hands over', async () => {
    const { storage, fuentes } = await storageWith({ a: solidClip(clips, 'h.mp4', '808080') });
    const input: ReelRenderInput = { guion: sceneGuion([{ media: 'a' }, { media: 'a' }, { media: 'a' }]), fuentes, kitVisual: KIT, outputSpec: FAST };
    await render(input, depsFor(storage), async (r) => {
      expect((await sha256Of(r.ruta)).equals(r.sha256)).toBe(true);
      expect(r.tamano).toBe((await stat(r.ruta)).size);
    });
  }, 120_000);

  it('removes the metadata of the sources (title, creation time, location, comment), with the default encoding and the real tooling check', async () => {
    const secrets = { title: 'Secreto-Titulo', creation_time: '2019-05-05T10:00:00Z', location: '+40.7128-074.0060/', comment: 'Secreto-Comentario' };
    const tagged = taggedClip(clips, 'tagged.mp4', secrets);
    const sourceFacts = await probeVideo(tagged, { ffprobePath: 'ffprobe', timeoutMs: 15_000 });
    expect(Object.keys(sourceFacts.tagsFormato)).toEqual(expect.arrayContaining(['title', 'creation_time', 'comment'])); // the source really has them

    const { storage, fuentes } = await storageWith({ a: tagged });
    const tooling = createFfmpegToolingGuard({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    const input: ReelRenderInput = { guion: sceneGuion([{ media: 'a' }, { media: 'a', entrada: 0, salida: 5000 }, { media: 'a' }]), fuentes, kitVisual: KIT };
    await render(input, depsFor(storage, { tooling }), async (r) => {
      const bytes = (await readFile(r.ruta)).toString('latin1');
      for (const secret of ['Secreto', '40.7128', '074.0060', '2019-05-05', 'Lavf', 'Lavc', 'x264']) expect(bytes.includes(secret), secret).toBe(false);
      expect(r.facts.tagsFormato).toEqual({ major_brand: 'isom', minor_version: '512', compatible_brands: 'isomiso2avc1mp41' });
      expect(r.facts.streams.map((s) => s.tags)).toEqual([{ language: 'und', handler_name: 'VideoHandler' }, { language: 'und', handler_name: 'SoundHandler' }]);
    });
  }, 180_000);

  // The expected picture is the upright pattern BY CONSTRUCTION: the helper rotates that pattern's
  // pixels by the inverse of the display rotation to make the coded frame, then sets the display
  // matrix. Nothing here comes from looking at what FFmpeg produced.
  it.each([90, 270] as const)('turns a phone clip with a %i degree display matrix upright (a pixel in each coloured quadrant)', async (rotation) => {
    const rotated = await rotatedQuadrantsClip(clips, `rot-${rotation}.mp4`, rotation);
    const probed = await probeVideo(rotated, { ffprobePath: 'ffprobe', timeoutMs: 15_000 });
    expect([probed.video!.ancho, probed.video!.alto]).toEqual([810, 1440]); // coded 1440x810, displayed upright

    const { storage, fuentes } = await storageWith({ a: rotated });
    const input: ReelRenderInput = { guion: sceneGuion([{ media: 'a' }, { media: 'a' }, { media: 'a' }]), fuentes, kitVisual: KIT, outputSpec: FAST };
    await render(input, depsFor(storage), async (r) => {
      const png = framePng(r.ruta, 2.5, path.join(root, `rot-frame-${rotation}.png`));
      const nearest = async (x: number, y: number) => {
        const p = await pixel(png, x, y);
        return (Object.entries(PATTERN_COLORS) as [string, readonly number[]][]).sort((m, n) => distance(p, m[1]) - distance(p, n[1]))[0]![0];
      };
      for (const { name, x, y } of UPRIGHT_PATTERN) expect(await nearest(x, y), `${rotation}: ${name} at ${x},${y}`).toBe(name);
    });
  }, 120_000);

  it('normalizes a variable frame rate source to exactly 30 fps and the planned number of frames', async () => {
    const vfr = variableFrameRateClip(clips, 'vfr.mp4', { seconds: 12 });
    const sourceFacts = await probeVideo(vfr, { ffprobePath: 'ffprobe', timeoutMs: 15_000 });
    expect(sourceFacts.video!.avgFrameRate).not.toBe('30/1');
    const { storage, fuentes } = await storageWith({ a: vfr });
    const input: ReelRenderInput = { guion: sceneGuion([{ media: 'a' }, { media: 'a', entrada: 5000, salida: 10_500 }, { media: 'a' }]), fuentes, kitVisual: KIT, outputSpec: FAST };
    const { result } = await render(input, depsFor(storage));
    expect(result.facts.video).toMatchObject({ rFrameRate: '30/1', avgFrameRate: '30/1', nbFrames: 450 });
  }, 120_000);

  it('tone-maps HDR sources (PQ and HLG) to SDR BT.709, and refuses them when this FFmpeg cannot', async () => {
    const files = { a: hdrClip(clips, 'pq.mp4', 'smpte2084'), b: hdrClip(clips, 'hlg.mp4', 'arib-std-b67'), c: solidClip(clips, 'sdr.mp4', '3355cc') };
    const probed = await probeVideo(files.a, { ffprobePath: 'ffprobe', timeoutMs: 15_000 });
    expect(probed.video!.hdr).toBe(true);
    const { storage, fuentes } = await storageWith(files);
    const input: ReelRenderInput = { guion: sceneGuion([{ media: 'a' }, { media: 'b' }, { media: 'c' }]), fuentes, kitVisual: KIT, outputSpec: FAST };

    const { result } = await render(input, depsFor(storage));
    expect(result.facts.video).toMatchObject({ pixFmt: 'yuv420p', colorSpace: 'bt709', colorTransfer: 'bt709', colorPrimaries: 'bt709', hdr: false });

    const error = await render(input, depsFor(storage, { tooling: async () => ({ version: 'test', hdr: false }) })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HdrNoSoportadoError);
    expect((error as HdrNoSoportadoError).escenas).toEqual([1, 2]);
    expect(await leftovers()).toEqual([]);
  }, 180_000);

  it('kills FFmpeg on timeout, rejects with a timeout and leaves no temporary folder', async () => {
    const { storage, fuentes } = await storageWith({ a: solidClip(clips, 't.mp4', '808080') });
    const input: ReelRenderInput = { guion: sceneGuion([{ media: 'a' }, { media: 'a' }, { media: 'a' }]), fuentes, kitVisual: KIT };
    const started = Date.now();
    const error = await render(input, depsFor(storage, { ffmpegTimeoutMs: 250 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegRunError);
    expect((error as FfmpegRunError).categoria).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await leftovers()).toEqual([]);
  }, 60_000);

  it('gives a typed error for a corrupt, truncated or non-video source, with no output and no temporary folder', async () => {
    const good = solidClip(clips, 'g.mp4', '808080');
    const goodBytes = await readFile(good);
    const png = await sharp({ create: { width: 800, height: 1400, channels: 3, background: '#445566' } }).png().toBuffer();
    const bad: Record<string, Buffer> = {
      garbage: Buffer.from(Array.from({ length: 5000 }, (_v, i) => (i * 131 + 7) % 256)),
      truncated: goodBytes.subarray(0, 3000),
      image: png,
    };
    for (const [name, bytes] of Object.entries(bad)) {
      const storage = new FakeStorage();
      await storage.put('cliente/media/bad.mp4', bytes);
      await storage.put('cliente/media/ok.mp4', goodBytes);
      const input: ReelRenderInput = { guion: sceneGuion([{ media: 'ok' }, { media: 'bad' }, { media: 'ok' }]), fuentes: { ok: 'cliente/media/ok.mp4', bad: 'cliente/media/bad.mp4' }, kitVisual: KIT, outputSpec: FAST };
      const error = await render(input, depsFor(storage)).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(FuenteDeVideoIlegibleError);
      expect((error as FuenteDeVideoIlegibleError).mediaId).toBe('bad');
      expect(await leftovers(), name).toEqual([]);
    }
  }, 60_000);

  it('refuses cheap problems before downloading anything: text that does not fit, glyphs the font lacks, a missing FFmpeg feature', async () => {
    const storage = new FakeStorage();
    await storage.put('cliente/media/a.mp4', await readFile(solidClip(clips, 'c1.mp4', '808080')));
    const getFile = vi.spyOn(storage, 'getFile');
    const fuentes = { a: 'cliente/media/a.mp4' };
    const run = (text: string, deps: ReelRenderDeps = depsFor(storage)) =>
      render({ guion: sceneGuion([{ media: 'a' }, { media: 'a', text }, { media: 'a' }]), fuentes, kitVisual: KIT, outputSpec: FAST }, deps).catch((e: unknown) => e);

    expect(await run('X'.repeat(300))).toBeInstanceOf(TextDoesNotFitError);
    expect(await run('日本語のテキスト')).toBeInstanceOf(UnsupportedGlyphsError);
    const missing = await run('ok', depsFor(storage, { tooling: async () => Promise.reject(new FfmpegToolingError('missing', ['libx264'])) }));
    expect(missing).toBeInstanceOf(FfmpegToolingError);
    expect(getFile).not.toHaveBeenCalled();
    expect(await leftovers()).toEqual([]);
  }, 60_000);

  it('refuses a source that is too small, with the media id and scene, and stores nothing', async () => {
    const small = patternClip(clips, 'small.mp4', { width: 640, height: 360 });
    const { storage, fuentes } = await storageWith({ a: solidClip(clips, 'big.mp4', '808080'), s: small });
    const error = await render({ guion: sceneGuion([{ media: 'a' }, { media: 's' }, { media: 'a' }]), fuentes, kitVisual: KIT, outputSpec: FAST }, depsFor(storage)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FuentesMuyPequenasError);
    expect((error as FuentesMuyPequenasError).mediaIds).toEqual(['s']);
    expect((error as FuentesMuyPequenasError).ordenes).toEqual([2]);
    expect(await leftovers()).toEqual([]);
  }, 60_000);

  it('logs the exit code and a fixed category, never stderr, paths or text', async () => {
    const { storage, fuentes } = await storageWith({ a: solidClip(clips, 'l.mp4', '808080') });
    const entries: unknown[] = [];
    const logger = { info: (...args: unknown[]) => entries.push(args), warn: (...args: unknown[]) => entries.push(args) } as never;
    const input: ReelRenderInput = { guion: sceneGuion([{ media: 'a', text: TEXT }, { media: 'a' }, { media: 'a' }]), fuentes, kitVisual: KIT, outputSpec: FAST };

    const failing = (async () => {
      throw new FfmpegRunError('filtro', 1);
    }) as never;
    await expect(render(input, depsFor(storage, { logger, runFfmpeg: failing }))).rejects.toBeInstanceOf(FfmpegRunError);
    await render(input, depsFor(storage, { logger }));
    const text = JSON.stringify(entries);
    expect(text).toContain('"categoria":"filtro"');
    expect(text).toContain('"exitCode":1');
    for (const forbidden of ['ñá', 'Hola', 'cafeter', 'prueba', 'novaciel-reel', 'ffmpeg']) expect(text.includes(forbidden), forbidden).toBe(false);
  }, 120_000);

  it('verifies the real output with an exact allow-list: tampered copies of a good file are refused', async () => {
    const { storage, fuentes } = await storageWith({ a: solidClip(clips, 'v.mp4', '808080') });
    const input: ReelRenderInput = { guion: sceneGuion([{ media: 'a' }, { media: 'a' }, { media: 'a' }]), fuentes, kitVisual: KIT, outputSpec: FAST };
    await render(input, depsFor(storage), async (r) => {
      const check = async (file: string) => {
        const facts = await probeVideo(file, { ffprobePath: 'ffprobe', timeoutMs: 15_000 });
        verifyReelOutput({ facts, layout: await inspectMp4(file), timeline: r.timeline, tamanoBytes: (await stat(file)).size });
      };
      const clean = ['-fflags', '+bitexact', '-map_metadata', '-1', '-movflags', '+faststart'];
      const out = (name: string) => path.join(root, `tamper-${name}.mp4`);

      await copyFile(r.ruta, out('original'));
      await check(out('original')); // the file as rendered passes
      await check(remux(r.ruta, out('control'), clean)); // a clean copy passes too: the checks below are not vacuous

      const refused = async (name: string, extra: readonly string[], razon: string, detalle?: string | RegExp) => {
        const error = await check(remux(r.ruta, out(name), extra)).catch((e: unknown) => e);
        expect(error, name).toBeInstanceOf(SalidaInvalidaError);
        expect((error as SalidaInvalidaError).razon, name).toBe(razon);
        if (typeof detalle === 'string') expect((error as SalidaInvalidaError).detalle, name).toBe(detalle);
        if (detalle instanceof RegExp) expect((error as SalidaInvalidaError).detalle, name).toMatch(detalle);
      };
      await refused('title', [...clean, '-metadata', 'title=Mi-titulo'], 'etiqueta_no_permitida', 'title');
      await refused('creation', [...clean, '-metadata', 'creation_time=2020-01-01T00:00:00Z'], 'etiqueta_no_permitida', 'creation_time');
      await refused('location', [...clean, '-metadata', 'location=+10.0+20.0/'], 'etiqueta_no_permitida', /^location/);
      await refused('handler', [...clean, '-metadata:s:v:0', 'handler_name=OtroNombre'], 'etiqueta_no_permitida', 'handler_name');
      await refused('language', [...clean, '-metadata:s:a:0', 'language=spa'], 'etiqueta_no_permitida', 'language');
      await refused('encoder', ['-movflags', '+faststart', '-map_metadata', '-1'], 'etiqueta_no_permitida', 'encoder'); // no bitexact: FFmpeg stamps its own version
      await refused('nofaststart', ['-fflags', '+bitexact', '-map_metadata', '-1'], 'faststart');
    });
  }, 120_000);
});

describe('renderReel (no FFmpeg needed)', () => {
  it('does not download or create anything when the tooling check fails', async () => {
    const storage = new FakeStorage();
    const getFile = vi.spyOn(storage, 'getFile');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'novaciel-reel-test-'));
    try {
      await writeFile(path.join(dir, 'keep.txt'), 'x');
      const error = await renderReel(
        { storage, tooling: () => Promise.reject(new FfmpegToolingError('not_found')), ffmpegPath: 'x', ffprobePath: 'y', ffmpegTimeoutMs: 1000, ffprobeTimeoutMs: 1000, tempRoot: dir },
        { guion: sceneGuion([{ media: 'a' }, { media: 'a' }, { media: 'a' }]), fuentes: { a: 'k' }, kitVisual: {} },
        async () => 'unreachable',
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FfmpegToolingError);
      expect(getFile).not.toHaveBeenCalled();
      expect(await readdir(dir)).toEqual(['keep.txt']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
