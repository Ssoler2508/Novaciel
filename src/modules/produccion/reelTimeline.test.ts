import { describe, expect, it } from 'vitest';
import {
  DuracionTotalFueraDeRangoError,
  EscenaMasLargaQueLaFuenteError,
  EscenaSinVideoError,
  FuentesMuyPequenasError,
  MarcasFueraDeRangoError,
  SourceTooSmallError,
  TimelineInvalidoError,
} from './errors.js';
import { buildReelTimeline, REEL_FPS, type ReelGuionInput, type ReelSourceMeta } from './reelTimeline.js';

const meta = (ancho: number, alto: number, duracionMs: number, extra: Partial<ReelSourceMeta> = {}): ReelSourceMeta => ({ ancho, alto, duracionMs, fps: 30, hdr: false, ...extra });

const LIBRARY: Record<string, ReelSourceMeta> = {
  vertical: meta(1080, 1920, 10_000),
  uhd: meta(3840, 2160, 8_000, { fps: 25 }),
  limite: meta(720, 1280, 20_000), // exactly 1.5 times
  hdr: meta(1080, 1920, 6_000, { hdr: true }),
  pequeno: meta(640, 360, 20_000),
  corto: meta(1080, 1920, 4_000),
};

interface Scene {
  dur?: number | undefined;
  media?: string | null;
  entrada?: number | null;
  salida?: number | null;
  text?: string;
  faltante?: boolean;
}

function guion(scenes: Scene[]): ReelGuionInput {
  return {
    contenido: { escenas: scenes.map((s, i) => ({ orden: i + 1, texto_en_pantalla: s.text ?? 'Texto de la escena', duracion_s: s.dur })) },
    tomas: scenes.map((s, i) => ({
      orden: i + 1,
      fuente: s.faltante ? ('faltante' as const) : ('media_real' as const),
      media_id: s.faltante ? null : s.media === undefined ? 'vertical' : s.media,
      entrada_ms: s.entrada ?? null,
      salida_ms: s.salida ?? null,
    })),
  };
}
const five = (extra: Scene = {}): Scene => ({ dur: 5, ...extra });

function fails<T extends Error>(run: () => unknown, type: new (...args: never[]) => T): T {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(type);
    return error as T;
  }
  throw new Error('expected a typed refusal');
}

describe('buildReelTimeline: segments', () => {
  it('cuts a 3-scene reel: frames, starts, crops and overlays', () => {
    const t = buildReelTimeline(
      guion([five({ media: 'vertical', text: 'Hola' }), five({ media: 'uhd', entrada: 1000, salida: 8000, text: '' }), five({ media: 'limite', entrada: 2000, salida: 12_000 })]),
      LIBRARY,
    );
    expect(t).toMatchObject({ fps: REEL_FPS, ancho: 1080, alto: 1920, totalFrames: 450, totalMs: 15_000 });
    expect(t.segmentos).toEqual([
      { escena: 1, mediaId: 'vertical', inicioMs: 0, frames: 150, duracionMs: 5000, recorte: { left: 0, top: 0, width: 1080, height: 1920 }, escala: 1, hdr: false, fpsFuente: 30, overlay: true },
      // 4K landscape: the centered 1215x2160 region, made even (1214 wide, offset 1312).
      { escena: 2, mediaId: 'uhd', inicioMs: 1000, frames: 150, duracionMs: 5000, recorte: { left: 1312, top: 0, width: 1214, height: 2160 }, escala: 1920 / 2160, hdr: false, fpsFuente: 25, overlay: false },
      // Exactly 1.5 times is allowed.
      { escena: 3, mediaId: 'limite', inicioMs: 2000, frames: 150, duracionMs: 5000, recorte: { left: 0, top: 0, width: 720, height: 1280 }, escala: 1.5, hdr: false, fpsFuente: 30, overlay: true },
    ]);
  });

  it('builds 4- and 6-scene mixes, with the same clip twice and an HDR clip', () => {
    const four = buildReelTimeline(
      guion([{ dur: 4, media: 'vertical', entrada: 0, salida: 4000 }, { dur: 4, media: 'vertical', entrada: 4000, salida: 8000 }, { dur: 4, media: 'hdr' }, { dur: 4.5, media: 'uhd' }]),
      LIBRARY,
    );
    expect(four.segmentos.map((s) => [s.escena, s.mediaId, s.inicioMs, s.frames, s.hdr])).toEqual([
      [1, 'vertical', 0, 120, false],
      [2, 'vertical', 4000, 120, false],
      [3, 'hdr', 0, 120, true],
      [4, 'uhd', 0, 135, false],
    ]);
    expect(four.totalFrames).toBe(495);
    expect(four.totalMs).toBe(16_500);

    const six = buildReelTimeline(guion(Array.from({ length: 6 }, () => ({ dur: 3.5, media: 'vertical' }))), LIBRARY);
    expect(six.segmentos).toHaveLength(6);
    expect(six.totalFrames).toBe(630);
  });

  it('starts at the in mark and takes the scene duration, even when the marked stretch is longer', () => {
    const t = buildReelTimeline(guion([five({ entrada: 1000, salida: 8000 }), five(), five({ entrada: 0, salida: 5000 })]), LIBRARY);
    expect(t.segmentos.map((s) => s.inicioMs)).toEqual([1000, 0, 0]);
    expect(t.segmentos.every((s) => s.frames === 150)).toBe(true);
  });

  it('rounds each scene to whole frames and reports exact totals', () => {
    const t = buildReelTimeline(guion([{ dur: 5.016 }, { dur: 5.016 }, { dur: 5.016 }]), LIBRARY); // 150.48 frames each
    expect(t.segmentos.map((s) => s.frames)).toEqual([150, 150, 150]);
    expect(t.segmentos.every((s) => s.duracionMs === 5000)).toBe(true);
    const odd = buildReelTimeline(guion([{ dur: 5.02 }, { dur: 5.02 }, { dur: 5.02 }]), LIBRARY); // 150.6 -> 151
    expect(odd.segmentos.map((s) => s.frames)).toEqual([151, 151, 151]);
    expect(odd.totalMs).toBe(Math.round((453 * 1000) / 30));
  });

  it('marks an overlay only for a scene with on-screen text', () => {
    const t = buildReelTimeline(guion([five({ text: 'Algo' }), five({ text: '' }), five({ text: '  \n\t ' })]), LIBRARY);
    expect(t.segmentos.map((s) => s.overlay)).toEqual([true, false, false]);
  });

  it('keeps every crop even and inside the displayed source', () => {
    for (const [ancho, alto] of [[3840, 2160], [4096, 2160], [2161, 3841], [1081, 1921], [1500, 2667]] as const) {
      const t = buildReelTimeline(guion([five({ media: 'x' }), five({ media: 'x' }), five({ media: 'x' })]), { x: meta(ancho, alto, 30_000) });
      for (const s of t.segmentos) {
        const { left, top, width, height } = s.recorte;
        expect([left, top, width, height].every((n) => n % 2 === 0 && n >= 0)).toBe(true);
        expect(left + width).toBeLessThanOrEqual(ancho);
        expect(top + height).toBeLessThanOrEqual(alto);
        expect(width).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('accepts exactly 15.0 and 30.0 seconds and refuses one frame less or more', () => {
    expect(buildReelTimeline(guion([five(), five(), five()]), LIBRARY).totalMs).toBe(15_000);
    expect(buildReelTimeline(guion(Array.from({ length: 6 }, () => five())), LIBRARY).totalMs).toBe(30_000);

    const short = fails(() => buildReelTimeline(guion([five(), five(), { dur: 4.97 }]), LIBRARY), DuracionTotalFueraDeRangoError); // 449 frames
    expect(short).toMatchObject({ minMs: 15_000, maxMs: 30_000, totalMs: 14_967 });
    const long = fails(() => buildReelTimeline(guion([five(), five(), five(), five(), five(), { dur: 5.03 }]), LIBRARY), DuracionTotalFueraDeRangoError); // 901 frames
    expect(long.totalMs).toBe(30_033);
  });

  it('has no text anywhere in the timeline', () => {
    const secret = 'TEXTO-SECRETO-DEL-CLIENTE';
    const t = buildReelTimeline(guion([five({ text: secret }), five({ text: secret }), five({ text: secret })]), LIBRARY);
    expect(JSON.stringify(t)).not.toContain('SECRETO');
  });
});

describe('buildReelTimeline: refusals', () => {
  it('refuses a structure that cannot be a reel', () => {
    const reason = (g: ReelGuionInput) => fails(() => buildReelTimeline(g, LIBRARY), TimelineInvalidoError).reason;
    expect(reason(guion([five(), five()]))).toBe('numero_de_escenas');
    expect(reason(guion(Array.from({ length: 7 }, () => ({ dur: 4 }))))).toBe('numero_de_escenas');

    const unordered = guion([five(), five(), five()]);
    unordered.contenido.escenas[1]!.orden = 5;
    expect(reason(unordered)).toBe('escenas_sin_orden');

    const missingSlot = guion([five(), five(), five()]);
    expect(reason({ ...missingSlot, tomas: missingSlot.tomas.slice(0, 2) })).toBe('tomas_distintas_de_escenas');
    const wrongSlot = guion([five(), five(), five()]);
    wrongSlot.tomas[2]!.orden = 4;
    expect(reason(wrongSlot)).toBe('tomas_distintas_de_escenas');

    for (const dur of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.01]) {
      expect(reason(guion([five(), five(), { dur }])), String(dur)).toBe('duracion_de_escena_invalida');
    }
    for (const bad of [meta(0, 1920, 1000), meta(1080, 1920, 0), meta(1080, 1920, Number.NaN), meta(1080.5, 1920, 1000), meta(1080, 1920, 1000, { fps: 0 })]) {
      expect(fails(() => buildReelTimeline(guion([five({ media: 'x' }), five(), five()]), { ...LIBRARY, x: bad }), TimelineInvalidoError).reason).toBe('metadatos_invalidos');
    }
  });

  it('refuses scenes without a video, listing all of them', () => {
    const error = fails(
      () => buildReelTimeline(guion([five({ faltante: true }), five(), five({ media: null }), five({ media: 'no-existe' })]), LIBRARY),
      EscenaSinVideoError,
    );
    expect(error.escenas).toEqual([1, 3, 4]);
    expect(error.message).toBe('3 scene(s) have no video (scenes 1, 3, 4)');
  });

  it('refuses in/out marks outside the clip, reversed or incomplete', () => {
    const bad = (s: Scene) => fails(() => buildReelTimeline(guion([five(), five(), five(s)]), LIBRARY), MarcasFueraDeRangoError).escenas;
    expect(bad({ entrada: 1000, salida: null })).toEqual([3]);
    expect(bad({ entrada: null, salida: 6000 })).toEqual([3]);
    expect(bad({ entrada: -1, salida: 6000 })).toEqual([3]);
    expect(bad({ entrada: 5000, salida: 5000 })).toEqual([3]);
    expect(bad({ entrada: 6000, salida: 5000 })).toEqual([3]);
    expect(bad({ entrada: 0, salida: 10_001 })).toEqual([3]); // the clip lasts 10 000 ms
    expect(bad({ entrada: 0.5, salida: 6000 })).toEqual([3]);
    const accepted = buildReelTimeline(guion([five(), five(), five({ entrada: 5000, salida: 10_000 })]), LIBRARY);
    expect(accepted.segmentos[2]!.inicioMs).toBe(5000);

    const many = fails(() => buildReelTimeline(guion([five({ entrada: 9000, salida: 20_000 }), five(), five({ entrada: 9, salida: 3 })]), LIBRARY), MarcasFueraDeRangoError);
    expect(many.escenas).toEqual([1, 3]);
  });

  it('refuses a scene longer than the stretch of its clip', () => {
    const long = (s: Scene[]) => fails(() => buildReelTimeline(guion(s), LIBRARY), EscenaMasLargaQueLaFuenteError).escenas;
    expect(long([five({ entrada: 1000, salida: 3000 }), five(), five()])).toEqual([1]); // 2 s marked, 5 s asked
    expect(long([five(), five({ media: 'corto' }), five({ media: 'corto', entrada: 0, salida: 4000 })])).toEqual([2, 3]); // clip of 4 s
    // Exactly as long as the stretch is fine.
    expect(buildReelTimeline(guion([five({ entrada: 0, salida: 5000 }), five(), five()]), LIBRARY).totalFrames).toBe(450);
  });

  it('refuses sources that would be enlarged more than 1.5 times, with the media ids and scene numbers', () => {
    const error = fails(
      () => buildReelTimeline(guion([five({ media: 'pequeno' }), five(), five({ media: 'pequeno', entrada: 1000, salida: 9000 }), five({ media: 'corto', entrada: 0, salida: 4000, dur: 4 })]), { ...LIBRARY }),
      FuentesMuyPequenasError,
    );
    expect(error).toBeInstanceOf(SourceTooSmallError);
    expect(error.mediaIds).toEqual(['pequeno']);
    expect(error.ordenes).toEqual([1, 3]);
    // Just under the limit: 719x1279.
    const justUnder = { ...LIBRARY, x: meta(719, 1279, 20_000) };
    expect(fails(() => buildReelTimeline(guion([five({ media: 'x' }), five(), five()]), justUnder), FuentesMuyPequenasError).ordenes).toEqual([1]);
  });

  it('reports the first failing rule in the documented order', () => {
    // Missing video beats bad marks, which beat a long scene, which beats a small source, which beats the total.
    expect(() => buildReelTimeline(guion([five({ faltante: true }), five({ entrada: 9, salida: 3 }), five()]), LIBRARY)).toThrow(EscenaSinVideoError);
    expect(() => buildReelTimeline(guion([five({ entrada: 9, salida: 3 }), five({ media: 'corto' }), five()]), LIBRARY)).toThrow(MarcasFueraDeRangoError);
    expect(() => buildReelTimeline(guion([five({ media: 'corto' }), five({ media: 'pequeno' }), five()]), LIBRARY)).toThrow(EscenaMasLargaQueLaFuenteError);
    expect(() => buildReelTimeline(guion([five({ media: 'pequeno' }), { dur: 1 }, { dur: 1 }]), LIBRARY)).toThrow(FuentesMuyPequenasError);
    expect(() => buildReelTimeline(guion([{ dur: 1 }, { dur: 1 }, { dur: 1 }]), LIBRARY)).toThrow(DuracionTotalFueraDeRangoError);
  });

  it('never puts text in an error message', () => {
    const secret = 'TEXTO-SECRETO-DEL-CLIENTE';
    const attempts: (() => unknown)[] = [
      () => buildReelTimeline(guion([five({ faltante: true, text: secret }), five({ text: secret }), five({ text: secret })]), LIBRARY),
      () => buildReelTimeline(guion([five({ entrada: 9, salida: 3, text: secret }), five(), five()]), LIBRARY),
      () => buildReelTimeline(guion([{ dur: 1, text: secret }, { dur: 1, text: secret }, { dur: 1, text: secret }]), LIBRARY),
    ];
    for (const attempt of attempts) expect(() => attempt()).toThrow(/^(?!.*SECRETO)/s);
  });
});
