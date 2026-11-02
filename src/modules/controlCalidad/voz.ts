import { crearCheck } from './crearCheck.js';
import type { CheckQC } from './tipos.js';

// The voice-over checks that need no file (Step 7d, ADR-07/ADR-08). PURE. The two that need the stored MP4
// (audible, loudness) are made in archivos.ts, which already has the file on disk.
//
//   voz_subtitulos_ausentes    BLOCKING: the production has voice-overs and no recorded template, so the voice has no
//                              word-by-word subtitles (spec 9.4: always on).
//   voz_etiqueta_ia_pendiente  WARNING: synthetic audio; the piece must carry the AI-content label when published
//                              (per network, TO CONFIRM). Shown to the NovaCiel reviewer.
//   voz_omitida_sin_plantilla  WARNING: the client has a voice but the reel came out silent because no subtitle
//                              template could be used (Remotion off). The reviewer must know it is not an oversight.

export interface EntradaChecksVoz {
  /** Only reels have a voice; other formats get no voice check. */
  esReel: boolean;
  /** The scenes with a voice-over record linked to the production. */
  escenasConVoz: readonly number[];
  /** The production records a text template. */
  plantillaRegistrada: boolean;
  /** Why the voice was left out of this production (column, or the audit row for older productions), or null. */
  vozOmitida: string | null;
  /** Where `vozOmitida` came from. Only the audit fallback is recorded in the parameters. Default: the column. */
  vozOmitidaOrigen?: 'columna' | 'auditoria' | null;
}

export function checksVoz(e: EntradaChecksVoz): CheckQC[] {
  if (!e.esReel) return [];
  const conVoz = e.escenasConVoz.length > 0;
  return [
    crearCheck('voz_subtitulos_ausentes', !conVoz || e.plantillaRegistrada, { escenas: [...e.escenasConVoz] }),
    crearCheck('voz_etiqueta_ia_pendiente', !conVoz, { escenas: [...e.escenasConVoz] }),
    crearCheck('voz_omitida_sin_plantilla', e.vozOmitida !== 'sin_plantilla', e.vozOmitidaOrigen === 'auditoria' ? { origen: 'auditoria' } : {}),
  ];
}
