import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HdrNoSoportadoError, RutaInvalidaError } from './errors.js';
import { buildFfmpegArgs, DEFAULT_REEL_OUTPUT, type ReelPaths } from './reelFfmpegArgs.js';
import { buildReelTimeline, type ReelGuionInput, type ReelSourceMeta } from './reelTimeline.js';

const meta = (ancho: number, alto: number, duracionMs: number, hdr = false): ReelSourceMeta => ({ ancho, alto, duracionMs, fps: 30, hdr });
const LIBRARY = { a: meta(1080, 1920, 10_000), b: meta(3840, 2160, 12_000), c: meta(1080, 1920, 8_000, true) };

function guion(texts: string[], dur = 5, media = ['a', 'b', 'c'], marks: ([number, number] | null)[] = [null, [1000, 9000], [500, 6000]]): ReelGuionInput {
  return {
    contenido: { escenas: texts.map((t, i) => ({ orden: i + 1, texto_en_pantalla: t, duracion_s: dur })) },
    tomas: texts.map((_t, i) => ({ orden: i + 1, fuente: 'media_real' as const, media_id: media[i]!, entrada_ms: marks[i]?.[0] ?? null, salida_ms: marks[i]?.[1] ?? null })),
  };
}

const abs = (...parts: string[]) => path.resolve(path.join(path.parse(process.cwd()).root, ...parts));
const PATHS: ReelPaths = {
  fuentes: { a: abs('work', 'a.mp4'), b: abs('work', 'b.mp4'), c: abs('work', 'c.mp4') },
  overlays: { 1: abs('work', 'ov1.png') },
  salida: abs('work', 'out.mp4'),
};

const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
const TAIL = 'scale=1080:1920:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p';
const HEAD = 'setpts=PTS-STARTPTS,fps=30,trim=end_frame=150,setpts=PTS-STARTPTS';

/** Everything after the filter graph, as fixed words and numbers. */
const OUTPUT_FLAGS = [
  '-map', '[vout]', '-map', '4:a',
  '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.1', '-crf', '20', '-preset', 'medium', '-maxrate', '12M', '-bufsize', '24M', '-g', '60', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-bsf:v', 'filter_units=remove_types=6,h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0',
  '-r', '30', '-fps_mode', 'cfr', '-frames:v', '450',
  '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
  '-map_metadata', '-1', '-map_chapters', '-1',
  '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-metadata:s:v:0', 'encoder=',
  '-movflags', '+faststart',
];

describe('buildFfmpegArgs: the exact argument array', () => {
  it('builds a 3-scene reel with one overlay and one HDR scene', () => {
    const timeline = buildReelTimeline(guion(['Hola', '', '']), LIBRARY);
    const args = buildFfmpegArgs(timeline, PATHS);
    const filters = [
      `[0:v]${HEAD},crop=1080:1920:0:0,${TAIL}[b1]`,
      '[1:v]format=rgba[o1]',
      '[b1][o1]overlay=0:0:format=auto:shortest=1[v1]',
      `[2:v]${HEAD},crop=1214:2160:1312:0,${TAIL}[v2]`,
      `[3:v]${HEAD},${TONEMAP},crop=1080:1920:0:0,${TAIL}[v3]`,
      '[v1][v2][v3]concat=n=3:v=1:a=0[vout]',
    ].join(';');
    expect(args).toEqual([
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', '0.000', '-t', '5.200', '-i', `file:${PATHS.fuentes.a}`,
      '-loop', '1', '-framerate', '30', '-t', '5.200', '-i', `file:${PATHS.overlays[1]}`,
      '-ss', '1.000', '-t', '5.200', '-i', `file:${PATHS.fuentes.b}`,
      '-ss', '0.500', '-t', '5.200', '-i', `file:${PATHS.fuentes.c}`,
      '-f', 'lavfi', '-t', '15.000', '-i', 'anullsrc=r=48000:cl=stereo',
      '-filter_complex', filters,
      ...OUTPUT_FLAGS,
      `file:${PATHS.salida}`,
    ]);
  });

  it('builds a reel without overlays or HDR: no overlay input, no tone mapping', () => {
    const timeline = buildReelTimeline(guion(['', '', ''], 5, ['a', 'a', 'a'], [[0, 6000], [5000, 10_000], [0, 5000]]), LIBRARY);
    const paths: ReelPaths = { fuentes: { a: PATHS.fuentes.a! }, overlays: {}, salida: PATHS.salida };
    const args = buildFfmpegArgs(timeline, paths);
    expect(args.filter((a) => a === '-loop')).toEqual([]);
    expect(args.filter((a) => a === '-i')).toHaveLength(4); // three scenes (the same file) + the silent track
    expect(args.join(' ')).not.toContain('zscale');
    expect(args.join(' ')).not.toContain('overlay=');
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(
      [0, 1, 2].map((i) => `[${i}:v]${HEAD},crop=1080:1920:0:0,${TAIL}[v${i + 1}]`).concat('[v1][v2][v3]concat=n=3:v=1:a=0[vout]').join(';'),
    );
    expect(args.slice(args.indexOf('-map'), -1)).toEqual(OUTPUT_FLAGS.map((a) => (a === '4:a' ? '3:a' : a)));
  });

  it('is deterministic', () => {
    const timeline = buildReelTimeline(guion(['Hola', '', '']), LIBRARY);
    expect(buildFfmpegArgs(timeline, PATHS)).toEqual(buildFfmpegArgs(timeline, PATHS));
    expect(buildFfmpegArgs(timeline, PATHS, { ...DEFAULT_REEL_OUTPUT })).toEqual(buildFfmpegArgs(timeline, PATHS));
  });

  it('writes every encoding flag exactly once and uses the spec values', () => {
    const args = buildFfmpegArgs(buildReelTimeline(guion(['Hola', '', '']), LIBRARY), PATHS, { ...DEFAULT_REEL_OUTPUT, crf: 23, preset: 'fast', maxrate: '8M', bufsize: '16M', gop: 90 });
    for (const flag of ['-c:v', '-crf', '-preset', '-maxrate', '-bufsize', '-g', '-pix_fmt', '-r', '-fps_mode', '-frames:v', '-c:a', '-map_metadata', '-map_chapters', '-movflags', '-filter_complex']) {
      expect(args.filter((a) => a === flag), flag).toHaveLength(1);
    }
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value('-crf')).toBe('23');
    expect(value('-preset')).toBe('fast');
    expect(value('-maxrate')).toBe('8M');
    expect(value('-bufsize')).toBe('16M');
    expect(value('-g')).toBe('90');
    expect(value('-map_metadata')).toBe('-1');
    expect(value('-movflags')).toBe('+faststart');
    expect(args.at(-1)).toBe(`file:${PATHS.salida}`);
  });

  it('refuses an HDR scene when this FFmpeg cannot tone-map', () => {
    const timeline = buildReelTimeline(guion(['Hola', '', '']), LIBRARY);
    const error = (() => {
      try {
        buildFfmpegArgs(timeline, PATHS, { ...DEFAULT_REEL_OUTPUT, hdrToneMap: false });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(HdrNoSoportadoError);
    expect((error as HdrNoSoportadoError).escenas).toEqual([3]);
    // Without an HDR scene the flag does not matter.
    const sdr = buildReelTimeline(guion(['', '', ''], 5, ['a', 'b', 'a'], [null, null, null]), LIBRARY);
    expect(() => buildFfmpegArgs(sdr, { fuentes: PATHS.fuentes, overlays: {}, salida: PATHS.salida }, { ...DEFAULT_REEL_OUTPUT, hdrToneMap: false })).not.toThrow();
  });

  it('refuses an invalid output spec', () => {
    const timeline = buildReelTimeline(guion(['Hola', '', '']), LIBRARY);
    for (const spec of [{ crf: -1 }, { crf: 52 }, { crf: 20.5 }, { gop: 0 }, { maxrate: '12M; rm -rf' }, { bufsize: '-1' }, { maxrate: '' }]) {
      expect(() => buildFfmpegArgs(timeline, PATHS, { ...DEFAULT_REEL_OUTPUT, ...spec })).toThrow(TypeError);
    }
  });
});

describe('buildFfmpegArgs: paths', () => {
  const timeline = buildReelTimeline(guion(['Hola', '', '']), LIBRARY);
  const reason = (paths: ReelPaths) => {
    try {
      buildFfmpegArgs(timeline, paths);
    } catch (error) {
      expect(error).toBeInstanceOf(RutaInvalidaError);
      return (error as RutaInvalidaError).reason;
    }
    throw new Error('expected a refusal');
  };

  it('refuses missing, extra, relative and control-character paths, without echoing them', () => {
    expect(reason({ ...PATHS, fuentes: { a: PATHS.fuentes.a!, b: PATHS.fuentes.b! } })).toBe('fuente_faltante');
    expect(reason({ ...PATHS, overlays: {} })).toBe('overlay_faltante');
    expect(reason({ ...PATHS, overlays: { 1: PATHS.overlays[1]!, 2: abs('work', 'ov2.png') } })).toBe('overlay_sobrante');
    expect(reason({ ...PATHS, salida: '' })).toBe('salida_faltante');
    expect(reason({ ...PATHS, salida: 'out.mp4' })).toBe('ruta_no_absoluta');
    expect(reason({ ...PATHS, fuentes: { ...PATHS.fuentes, a: '-i' } })).toBe('ruta_no_absoluta');
    expect(reason({ ...PATHS, fuentes: { ...PATHS.fuentes, a: `${abs('work')}${path.sep}a\n.mp4` } })).toBe('ruta_con_caracter_de_control');
    try {
      buildFfmpegArgs(timeline, { ...PATHS, salida: 'secret-relative.mp4' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('writes a path that looks like an option or a protocol as a plain file: path', () => {
    const odd = abs('work', 'concat:http://evil;x');
    const args = buildFfmpegArgs(timeline, { ...PATHS, fuentes: { ...PATHS.fuentes, a: odd } });
    expect(args).toContain(`file:${odd}`);
    expect(args.filter((a) => a.startsWith('concat:'))).toEqual([]);
    expect(args.filter((a) => a.startsWith('http:'))).toEqual([]);
  });

  it('accepts a Windows-style path with spaces, accents and backslashes untouched', () => {
    if (process.platform !== 'win32') return;
    const odd = 'C:\\Users\\soler\\AppData\\Local\\Temp\\prueba reel ñá\\vídeo (1).mp4';
    const args = buildFfmpegArgs(timeline, { ...PATHS, fuentes: { ...PATHS.fuentes, a: odd } });
    expect(args).toContain(`file:${odd}`);
  });

  it('contains no path but the ones passed in', () => {
    const args = buildFfmpegArgs(timeline, PATHS);
    const files = args.filter((a) => a.startsWith('file:')).sort();
    expect(files).toEqual([`file:${PATHS.fuentes.a}`, `file:${PATHS.fuentes.b}`, `file:${PATHS.fuentes.c}`, `file:${PATHS.overlays[1]}`, `file:${PATHS.salida}`].sort());
  });
});

// A seeded generator, so the property test is repeatable (fast-check is not a dependency).
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABET = [...`abcXYZ 0123456789-_=;,:[]()'"\`$%&|\\/\n\t.áéíóúñ¿?¡!😀日本語ﬁ{}<>@#^~*+`, 'file:', 'concat:', '-i ', '-y ', '[v1]', ';', 'drawtext=text=', 'movie='];

describe('buildFfmpegArgs: no client text reaches an argument', () => {
  it('ignores the copy completely, over 200 random briefs', () => {
    const random = mulberry32(20261018);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    const text = () => Array.from({ length: 8 + Math.floor(random() * 70) }, () => pick(ALPHABET)).join('');
    let withOverlay = 0;

    for (let n = 0; n < 200; n++) {
      const scenes = 3 + Math.floor(random() * 3);
      const texts = Array.from({ length: scenes }, () => (random() < 0.3 ? '' : text()));
      const durations = scenes === 3 ? 5 : scenes === 4 ? 4 : 3.5;
      const media = Array.from({ length: scenes }, () => pick(['a', 'b', 'c']));
      const marks = media.map(() => null);
      const noisy = guion(texts, durations, media, marks);
      // The whole brief carries random copy, not only the scenes.
      Object.assign(noisy.contenido, { gancho: text(), portada: text(), notas_produccion: text(), llamado_a_accion: text(), texto_publicacion: { texto: text(), hashtags: [text()], ubicacion: text() } });
      const plain = guion(texts.map((t) => (t.trim() === '' ? '' : 'x')), durations, media, marks);

      const timeline = buildReelTimeline(noisy, LIBRARY);
      const overlays: Record<number, string> = {};
      for (const s of timeline.segmentos) if (s.overlay) overlays[s.escena] = abs('work', `ov${s.escena}.png`);
      withOverlay += Object.keys(overlays).length;
      const paths: ReelPaths = { fuentes: PATHS.fuentes, overlays, salida: PATHS.salida };
      const args = buildFfmpegArgs(timeline, paths);

      // The same brief with every text replaced by "x" gives the very same timeline and arguments.
      expect(timeline).toEqual(buildReelTimeline(plain, LIBRARY));
      expect(args).toEqual(buildFfmpegArgs(buildReelTimeline(plain, LIBRARY), paths));
      // And none of the copy is anywhere in them.
      const everything = JSON.stringify(timeline) + '\u0000' + args.join('\u0000');
      for (const t of texts) if (t.trim().length >= 8) expect(everything.includes(t.trim())).toBe(false);
    }
    expect(withOverlay).toBeGreaterThan(100); // the generator really exercised overlays
  });

  it('makes every argument a fixed word, a number, a filter graph or exactly one passed path', () => {
    const passed = new Set([PATHS.fuentes.a, PATHS.fuentes.b, PATHS.fuentes.c, PATHS.overlays[1], PATHS.salida].map((p) => `file:${p}`));
    const args = buildFfmpegArgs(buildReelTimeline(guion(['Hola ; drawtext=text=x', '', '']), LIBRARY), PATHS);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    for (const arg of args) {
      if (arg === graph) continue;
      expect(passed.has(arg) || /^-[a-zA-Z_:0-9]+$/.test(arg) || /^[0-9.+-]+$/.test(arg) || /^(\+?[a-z0-9_.:=\[\]-]+|[0-9]+:a|-1|[0-9]+[kM]|\+faststart|\+bitexact|anullsrc=r=48000:cl=stereo|encoder=|filter_units=remove_types=6,h264_metadata=[a-z_=0-9:]+)$/i.test(arg), arg).toBe(true);
    }
    // The graph is made only of stream labels, filter names, numbers and the fixed punctuation.
    expect(graph).toMatch(/^[\w\[\]:=.,;|+\-]*$/);
    expect(graph).not.toContain('drawtext');
  });
});

describe('buildFfmpegArgs: a PNG sequence overlay (Step 7c)', () => {
  const timeline = buildReelTimeline(guion(['Hello', '', '']), LIBRARY);
  const carpeta = abs('work', 'capa-1');

  it('reads the sequence as an image2 input at 30 fps from frame 0, with the same overlay filter', () => {
    const args = buildFfmpegArgs(timeline, { ...PATHS, overlays: { 1: { carpeta, patron: 'capa-%05d.png' } } });
    const joined = args.join(' ');
    expect(joined).toContain(`-framerate 30 -start_number 0 -f image2 -i file:${carpeta}/capa-%05d.png`);
    expect(joined).not.toContain('-loop 1');
    expect(joined).toContain('[b1][o1]overlay=0:0:format=auto:shortest=1[v1]');
    // Same scenes, same output flags as the PNG version.
    const png = buildFfmpegArgs(timeline, PATHS);
    expect(args.slice(args.indexOf('-map'))).toEqual(png.slice(png.indexOf('-map')));
  });

  it('refuses a folder with % or control characters, a foreign pattern and a missing sequence', () => {
    const reason = (overlays: ReelPaths['overlays']) => {
      try {
        buildFfmpegArgs(timeline, { ...PATHS, overlays });
      } catch (error) {
        return (error as RutaInvalidaError).reason;
      }
      throw new Error('expected a refusal');
    };
    expect(reason({ 1: { carpeta: abs('work', '50%'), patron: 'capa-%05d.png' } })).toBe('ruta_con_patron');
    expect(reason({ 1: { carpeta: `${abs('work')}${path.sep}a\nb`, patron: 'capa-%05d.png' } })).toBe('ruta_con_caracter_de_control');
    expect(reason({ 1: { carpeta: 'relative', patron: 'capa-%05d.png' } })).toBe('ruta_no_absoluta');
    expect(reason({ 1: { carpeta, patron: '%d.png' } })).toBe('overlay_faltante');
    expect(reason({})).toBe('overlay_faltante');
    expect(reason({ 1: { carpeta, patron: 'capa-%05d.png' }, 2: { carpeta, patron: 'capa-%05d.png' } })).toBe('overlay_sobrante');
  });

  it('carries no client text: only the folder is a free string', () => {
    const args = buildFfmpegArgs(buildReelTimeline(guion(['SECRET copy', '', '']), LIBRARY), { ...PATHS, overlays: { 1: { carpeta, patron: 'capa-%05d.png' } } });
    expect(args.join('\n')).not.toContain('SECRET');
  });
});
