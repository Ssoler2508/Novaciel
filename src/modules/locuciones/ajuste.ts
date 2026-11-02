import { LIMITES_FORMATO } from '../directorCreativo/limits.js';
import { framesToMs, REEL_FPS, reelSceneMs } from '../produccion/reelTimeline.js';
import {
  DuracionReelFueraDeRangoError,
  LocucionEntradaInvalidaError,
  LocucionMasLargaQueEscenaError,
  type EscenaExcedida,
} from './errors.js';

// Fit policy (Step 7d, ADR-08): a voice longer than its scene is REFUSED so the brief is regenerated
// shorter. No speed change, no cut words. PURE.
//
// The scene is the RENDERED scene: whole frames, as 7b's timeline cuts it (`reelSceneMs`), not the
// brief's rounded `duracion_s`. The reel total is checked the way the timeline checks it too.

export interface MargenesVoz {
  /** Silence before the voice starts in its scene. */
  entradaMs: number;
  /** Silence kept after the voice ends, before the next scene. */
  colaMs: number;
}

/** House values (VERIFY with real reels). */
export const MARGENES_VOZ: MargenesVoz = { entradaMs: 150, colaMs: 300 };

const esMs = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** How many ms the voice and its margins exceed the scene by (0 or less when it fits). */
function exceso(duracionVozMs: number, duracionEscenaMs: number, margenes: MargenesVoz): number {
  return margenes.entradaMs + duracionVozMs + margenes.colaMs - duracionEscenaMs;
}

/** Throws LocucionMasLargaQueEscenaError when the voice with its margins is longer than the rendered scene. */
export function comprobarAjusteEscena(input: {
  escena: number;
  duracionVozMs: number;
  duracionEscenaMs: number;
  margenes?: MargenesVoz;
}): void {
  if (!esMs(input.duracionVozMs)) throw new LocucionEntradaInvalidaError('duracion_de_voz_invalida');
  if (!Number.isInteger(input.duracionEscenaMs) || input.duracionEscenaMs < 1) throw new LocucionEntradaInvalidaError('duracion_de_escena_invalida');
  const sobra = exceso(input.duracionVozMs, input.duracionEscenaMs, input.margenes ?? MARGENES_VOZ);
  if (sobra > 0) throw new LocucionMasLargaQueEscenaError([{ escena: input.escena, excesoMs: sobra }]);
}

export interface EscenaDeReel {
  /** Scene number, 1-based. */
  escena: number;
  /** The brief's `duracion_s` of the scene. */
  duracionS: number;
  /** The voice of the scene, or null when it has none. */
  duracionVozMs: number | null;
}

export interface AjusteReel {
  /** The rendered length of each scene, in the order given. */
  escenas: readonly { escena: number; duracionEscenaMs: number }[];
  totalMs: number;
}

/**
 * Checks every scene of a reel and the whole: lists ALL scenes whose voice does not fit, then checks
 * the total against the house range. Returns the rendered lengths.
 */
export function comprobarAjusteReel(escenas: readonly EscenaDeReel[], margenes: MargenesVoz = MARGENES_VOZ): AjusteReel {
  if (escenas.length === 0) throw new LocucionEntradaInvalidaError('escenas_vacias');
  const excedidas: EscenaExcedida[] = [];
  let totalFrames = 0;
  const lista = escenas.map((e) => {
    if (typeof e.duracionS !== 'number' || !Number.isFinite(e.duracionS) || e.duracionS <= 0) throw new LocucionEntradaInvalidaError('duracion_de_escena_invalida');
    const frames = Math.round(e.duracionS * REEL_FPS);
    if (frames < 1) throw new LocucionEntradaInvalidaError('duracion_de_escena_invalida');
    totalFrames += frames;
    const duracionEscenaMs = reelSceneMs(e.duracionS);
    if (e.duracionVozMs !== null) {
      if (!esMs(e.duracionVozMs)) throw new LocucionEntradaInvalidaError('duracion_de_voz_invalida');
      const sobra = exceso(e.duracionVozMs, duracionEscenaMs, margenes);
      if (sobra > 0) excedidas.push({ escena: e.escena, excesoMs: sobra });
    }
    return { escena: e.escena, duracionEscenaMs };
  });
  if (excedidas.length > 0) throw new LocucionMasLargaQueEscenaError(excedidas);

  const { min, max } = LIMITES_FORMATO.reel.duracionTotalS!;
  const totalMs = framesToMs(totalFrames);
  if (totalFrames < min * REEL_FPS || totalFrames > max * REEL_FPS) throw new DuracionReelFueraDeRangoError(totalMs, min * 1000, max * 1000);
  return { escenas: lista, totalMs };
}

// ---- Free lower bound, before paying -----------------------------------------------------------------

/**
 * The fastest speech the code assumes, in characters per second (HOUSE VALUE, VERIFY with real voices: normal
 * Spanish is about 14 to 16; 24 is deliberately faster than any real voice, so the bound never refuses a
 * voice that would have fitted).
 */
export const CARACTERES_POR_SEGUNDO_MAXIMOS = 24;

/** The least time a text of `caracteres` can take at the given voice speed. */
export function duracionMinimaVozMs(caracteres: number, velocidad: number): number {
  if (!Number.isInteger(caracteres) || caracteres < 0 || typeof velocidad !== 'number' || !Number.isFinite(velocidad) || velocidad <= 0) {
    throw new LocucionEntradaInvalidaError('duracion_de_voz_invalida');
  }
  return Math.ceil((caracteres * 1000) / (CARACTERES_POR_SEGUNDO_MAXIMOS * velocidad));
}

export interface EscenaParaCota {
  escena: number;
  duracionS: number;
  /** Characters of the prepared text, or null when the scene has no voice. */
  caracteres: number | null;
}

/**
 * Before any voice is paid for: if even the fastest possible reading of a text does not fit its rendered scene
 * (with the margins), no real voice will, so the production is refused with LocucionMasLargaQueEscenaError
 * listing ALL such scenes, and nothing is spent. A text that passes may still be too long once the real voice
 * is measured; that is checked with comprobarAjusteReel after generating.
 */
export function comprobarCotaMinimaReel(escenas: readonly EscenaParaCota[], velocidad: number, margenes: MargenesVoz = MARGENES_VOZ): void {
  const excedidas: EscenaExcedida[] = [];
  for (const e of escenas) {
    if (typeof e.duracionS !== 'number' || !Number.isFinite(e.duracionS) || e.duracionS <= 0 || Math.round(e.duracionS * REEL_FPS) < 1) {
      throw new LocucionEntradaInvalidaError('duracion_de_escena_invalida');
    }
    if (e.caracteres === null) continue;
    const sobra = exceso(duracionMinimaVozMs(e.caracteres, velocidad), reelSceneMs(e.duracionS), margenes);
    if (sobra > 0) excedidas.push({ escena: e.escena, excesoMs: sobra });
  }
  if (excedidas.length > 0) throw new LocucionMasLargaQueEscenaError(excedidas);
}
