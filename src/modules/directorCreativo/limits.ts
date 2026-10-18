import type { Formato } from '../planificador/types.js';
import type { MediaTipo } from './types.js';

// Limits of a brief. SOURCES:
//  - spec 9.6: a carousel has 5 to 10 slides;
//  - spec 8: a video lasts 15 to 30 seconds by default;
//  - everything else is a HOUSE CAP chosen below the public maximum of each network so a wrong guess
//    is harmless. VERIFICAR each one against the networks' own documentation before production.

/**
 * Shortest source video offered for a reel, in ms. HOUSE VALUE, VERIFICAR: spec 9.4 asks for a cut or
 * visual change every 2 to 4 seconds, so a scene is rarely shorter than 2 s.
 */
export const MIN_DURACION_VIDEO_MS = 2000;

/** Candidate media shown to the model per piece. */
export const MAX_CANDIDATOS = 12;

export interface FormatLimits {
  escenasMin: number;
  escenasMax: number;
  /** Total length of the scenes, in seconds. Reels only (spec 8). */
  duracionTotalS?: { min: number; max: number };
  /** Media types a slot of this format accepts. */
  tiposMedia: readonly MediaTipo[];
  /** Image formats need alt text on every slide. */
  requiereTextoAlternativo: boolean;
}

export const LIMITES_FORMATO: Record<Formato, FormatLimits> = {
  // Spec 8: short video of 15 to 30 s. Scenes count (3 to 6) is a house cap. Photos animated into a
  // reel are Step 7's "animacion_ia", so a reel slot takes video only.
  reel: { escenasMin: 3, escenasMax: 6, duracionTotalS: { min: 15, max: 30 }, tiposMedia: ['video'], requiereTextoAlternativo: false },
  // Spec 9.6: 5 to 10 slides.
  carrusel: { escenasMin: 5, escenasMax: 10, tiposMedia: ['foto'], requiereTextoAlternativo: true },
  // Spec 9.6: "post de imagen e historia: misma logica". House caps: one image; up to 3 story frames.
  post: { escenasMin: 1, escenasMax: 1, tiposMedia: ['foto'], requiereTextoAlternativo: true },
  historia: { escenasMin: 1, escenasMax: 3, tiposMedia: ['foto', 'video'], requiereTextoAlternativo: true },
};

/** House caps in characters (VERIFICAR): same for the four networks for now. */
export const LIMITES_TEXTO = {
  gancho: 100,
  textoEnPantalla: 150,
  textoAlternativo: 100,
  vozEnOff: 300,
  textoPublicacion: 2000,
  ubicacion: 100,
  llamadoAccion: 150,
  musica: 100,
  portada: 150,
  notasProduccion: 500,
  motivo: 200,
} as const;

/** House cap (VERIFICAR): hashtags per piece. */
export const MAX_HASHTAGS = 10;
/** Facts the planner may attach to a piece, so also the most omissions a brief can explain. */
export const MAX_HECHOS_OMITIDOS = 5;

export interface BriefLimits {
  formato: FormatLimits;
  texto: typeof LIMITES_TEXTO;
  hashtagsMax: number;
}

export function limitesDe(formato: Formato): BriefLimits {
  return { formato: LIMITES_FORMATO[formato], texto: LIMITES_TEXTO, hashtagsMax: MAX_HASHTAGS };
}
