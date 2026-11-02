import { describe, expect, it } from 'vitest';
import { buildReelTimeline, REEL_FPS, reelSceneMs, type ReelGuionInput, type ReelSourceMeta } from '../produccion/reelTimeline.js';
import { comprobarAjusteEscena, comprobarAjusteReel, MARGENES_VOZ, type EscenaDeReel } from './ajuste.js';
import { DuracionReelFueraDeRangoError, LocucionEntradaInvalidaError, LocucionMasLargaQueEscenaError } from './errors.js';

const SCENE_MS = 5000;
const { entradaMs, colaMs } = MARGENES_VOZ;
const MAX_VOZ = SCENE_MS - entradaMs - colaMs;

function falla<T extends Error>(run: () => unknown, type: new (...args: never[]) => T): T {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(type);
    return error as T;
  }
  throw new Error('expected a refusal');
}

describe('comprobarAjusteEscena', () => {
  it('accepts a voice that fits exactly with its margins and refuses one more millisecond', () => {
    expect(() => comprobarAjusteEscena({ escena: 1, duracionVozMs: MAX_VOZ, duracionEscenaMs: SCENE_MS })).not.toThrow();
    const e = falla(() => comprobarAjusteEscena({ escena: 2, duracionVozMs: MAX_VOZ + 1, duracionEscenaMs: SCENE_MS }), LocucionMasLargaQueEscenaError);
    expect(e.escenas).toEqual([{ escena: 2, excesoMs: 1 }]);
  });

  it('accepts a zero-length voice and uses custom margins', () => {
    expect(() => comprobarAjusteEscena({ escena: 1, duracionVozMs: 0, duracionEscenaMs: 1000 })).not.toThrow();
    expect(() => comprobarAjusteEscena({ escena: 1, duracionVozMs: 1000, duracionEscenaMs: 1000, margenes: { entradaMs: 0, colaMs: 0 } })).not.toThrow();
    falla(() => comprobarAjusteEscena({ escena: 1, duracionVozMs: 1000, duracionEscenaMs: 1000 }), LocucionMasLargaQueEscenaError);
  });

  it('refuses invalid numbers', () => {
    for (const duracionVozMs of [-1, 1.5, Number.NaN]) {
      expect(falla(() => comprobarAjusteEscena({ escena: 1, duracionVozMs, duracionEscenaMs: 1000 }), LocucionEntradaInvalidaError).reason).toBe('duracion_de_voz_invalida');
    }
    expect(falla(() => comprobarAjusteEscena({ escena: 1, duracionVozMs: 1, duracionEscenaMs: 0 }), LocucionEntradaInvalidaError).reason).toBe('duracion_de_escena_invalida');
  });
});

const reel = (duraciones: number[], voz: (number | null)[] = []): EscenaDeReel[] =>
  duraciones.map((duracionS, i) => ({ escena: i + 1, duracionS, duracionVozMs: voz[i] ?? null }));

describe('comprobarAjusteReel', () => {
  it('accepts a reel inside 15 to 30 s with voices that fit and returns the rendered lengths', () => {
    const r = comprobarAjusteReel(reel([5, 5, 5], [MAX_VOZ, 1000, null]));
    expect(r.totalMs).toBe(15_000);
    expect(r.escenas).toEqual([
      { escena: 1, duracionEscenaMs: 5000 },
      { escena: 2, duracionEscenaMs: 5000 },
      { escena: 3, duracionEscenaMs: 5000 },
    ]);
  });

  it('lists ALL the scenes whose voice does not fit', () => {
    const e = falla(() => comprobarAjusteReel(reel([5, 5, 5, 5], [MAX_VOZ + 10, 100, MAX_VOZ + 1, null])), LocucionMasLargaQueEscenaError);
    expect(e.escenas).toEqual([
      { escena: 1, excesoMs: 10 },
      { escena: 3, excesoMs: 1 },
    ]);
  });

  it('checks the whole reel against 15 to 30 s, at the frame', () => {
    expect(() => comprobarAjusteReel(reel([5, 5, 5]))).not.toThrow(); // 15 s
    expect(() => comprobarAjusteReel(reel([10, 10, 10]))).not.toThrow(); // 30 s
    const corto = falla(() => comprobarAjusteReel(reel([5, 5, 4.9])), DuracionReelFueraDeRangoError);
    expect(corto).toMatchObject({ totalMs: 14_900, minMs: 15_000, maxMs: 30_000 });
    falla(() => comprobarAjusteReel(reel([10, 10, 10.1])), DuracionReelFueraDeRangoError);
  });

  it('refuses invalid structure', () => {
    expect(falla(() => comprobarAjusteReel([]), LocucionEntradaInvalidaError).reason).toBe('escenas_vacias');
    for (const duracionS of [0, -1, Number.NaN, 0.01]) {
      expect(falla(() => comprobarAjusteReel(reel([duracionS, 5, 5])), LocucionEntradaInvalidaError).reason).toBe('duracion_de_escena_invalida');
    }
    expect(falla(() => comprobarAjusteReel(reel([5, 5, 5], [-5])), LocucionEntradaInvalidaError).reason).toBe('duracion_de_voz_invalida');
  });

  it('checks the voice against the RENDERED scene (whole frames), not the rounded duracion_s', () => {
    // 3.01 s is 90 frames (3000 ms) at 30 fps: the scene is 3000 ms, not 3010.
    expect(reelSceneMs(3.01)).toBe(3000);
    const voz = 3010 - entradaMs - colaMs; // fits a 3.01 s scene on paper, not the 3000 ms rendered
    const e = falla(() => comprobarAjusteReel(reel([3.01, 6, 6], [voz])), LocucionMasLargaQueEscenaError);
    expect(e.escenas).toEqual([{ escena: 1, excesoMs: 10 }]);
  });
});

describe('the voice check uses the same scene lengths as the 7b timeline', () => {
  const meta: ReelSourceMeta = { ancho: 1080, alto: 1920, duracionMs: 20_000, fps: 30, hdr: false };

  // Durations that are NOT whole frames, so the rounding matters.
  const CASOS: number[][] = [
    [5, 5, 5],
    [4.01, 5.33, 6.67],
    [3.017, 5.49, 7.5],
    [2.51, 2.52, 2.53, 2.54, 2.55, 2.56],
    [10.02, 9.99, 9.98],
    [4.999, 5.001, 5.0005],
  ];

  for (const duraciones of CASOS) {
    it(`reelSceneMs, comprobarAjusteReel and buildReelTimeline agree for ${duraciones.join(' + ')} s`, () => {
      const guion: ReelGuionInput = {
        contenido: { escenas: duraciones.map((d, i) => ({ orden: i + 1, texto_en_pantalla: 'Texto', duracion_s: d })) },
        tomas: duraciones.map((_d, i) => ({ orden: i + 1, fuente: 'media_real' as const, media_id: 'clip', entrada_ms: null, salida_ms: null })),
      };
      const timeline = buildReelTimeline(guion, { clip: meta });
      const ajuste = comprobarAjusteReel(reel(duraciones));
      expect(ajuste.escenas.map((e) => e.duracionEscenaMs)).toEqual(timeline.segmentos.map((s) => s.duracionMs));
      expect(ajuste.totalMs).toBe(timeline.totalMs);
      expect(duraciones.map(reelSceneMs)).toEqual(timeline.segmentos.map((s) => s.duracionMs));
      // And both are whole frames: frames * 1000 / 30, rounded.
      timeline.segmentos.forEach((s) => expect(s.duracionMs).toBe(Math.round((s.frames * 1000) / REEL_FPS)));
    });

    it(`the 7b timeline and the voice check agree on the total range for ${duraciones.join(' + ')} s`, () => {
      const total = duraciones.reduce((a, d) => a + Math.round(d * REEL_FPS), 0);
      const dentro = total >= 15 * REEL_FPS && total <= 30 * REEL_FPS;
      expect(() => comprobarAjusteReel(reel(duraciones))).not.toThrow();
      expect(dentro).toBe(true);
    });
  }

  it('they refuse the same totals', () => {
    for (const duraciones of [[5, 5, 4.9], [10, 10, 10.1]]) {
      const guion: ReelGuionInput = {
        contenido: { escenas: duraciones.map((d, i) => ({ orden: i + 1, texto_en_pantalla: 'T', duracion_s: d })) },
        tomas: duraciones.map((_d, i) => ({ orden: i + 1, fuente: 'media_real' as const, media_id: 'clip', entrada_ms: null, salida_ms: null })),
      };
      expect(() => buildReelTimeline(guion, { clip: meta })).toThrow();
      expect(() => comprobarAjusteReel(reel(duraciones))).toThrow(DuracionReelFueraDeRangoError);
    }
  });
});

import { CARACTERES_POR_SEGUNDO_MAXIMOS, comprobarCotaMinimaReel, duracionMinimaVozMs } from './ajuste.js';

describe('the free lower bound before paying', () => {
  it('is the characters over the fastest speech, shorter at a faster voice speed', () => {
    expect(CARACTERES_POR_SEGUNDO_MAXIMOS).toBe(24);
    expect(duracionMinimaVozMs(24, 1)).toBe(1000);
    expect(duracionMinimaVozMs(120, 1)).toBe(5000);
    expect(duracionMinimaVozMs(120, 1.2)).toBe(4167);
    expect(duracionMinimaVozMs(0, 1)).toBe(0);
    expect(() => duracionMinimaVozMs(-1, 1)).toThrow(LocucionEntradaInvalidaError);
    expect(() => duracionMinimaVozMs(10, 0)).toThrow(LocucionEntradaInvalidaError);
  });

  const escena = (n: number, caracteres: number | null, duracionS = 5) => ({ escena: n, duracionS, caracteres });
  // A 5 s scene minus 150 ms of lead-in and 300 ms of tail leaves 4550 ms: 109.2 characters at 24 per second.
  it('lets a text through when the fastest reading fits and refuses when even that does not, listing ALL scenes', () => {
    expect(() => comprobarCotaMinimaReel([escena(1, 109), escena(2, null), escena(3, 0)], 1)).not.toThrow();
    const e = falla(() => comprobarCotaMinimaReel([escena(1, 110), escena(2, 50), escena(3, 400)], 1), LocucionMasLargaQueEscenaError);
    expect(e.escenas.map((x) => x.escena)).toEqual([1, 3]);
    expect(e.escenas[0]!.excesoMs).toBeGreaterThan(0);
  });

  it('a faster voice setting lowers the bound', () => {
    expect(() => comprobarCotaMinimaReel([escena(1, 120)], 1)).toThrow(LocucionMasLargaQueEscenaError);
    expect(() => comprobarCotaMinimaReel([escena(1, 120)], 1.2)).not.toThrow();
  });

  it('measures the RENDERED scene (whole frames)', () => {
    // 3.01 s renders as 3000 ms: 2550 ms of room, 61.2 characters.
    expect(() => comprobarCotaMinimaReel([escena(1, 61, 3.01)], 1)).not.toThrow();
    expect(() => comprobarCotaMinimaReel([escena(1, 62, 3.01)], 1)).toThrow(LocucionMasLargaQueEscenaError);
  });

  it('refuses invalid durations', () => {
    expect(() => comprobarCotaMinimaReel([escena(1, 10, 0)], 1)).toThrow(LocucionEntradaInvalidaError);
    expect(() => comprobarCotaMinimaReel([escena(1, 10, Number.NaN)], 1)).toThrow(LocucionEntradaInvalidaError);
  });
});
