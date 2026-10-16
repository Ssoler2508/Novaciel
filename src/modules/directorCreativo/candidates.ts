import type { Formato, ReglaPlanner } from '../planificador/types.js';
import { containsText, fold } from '../planificador/textMatch.js';
import { LIMITES_FORMATO, MAX_CANDIDATOS } from './limits.js';
import type { MediaCandidate } from './types.js';

// Media preselection, in code and not by the model: the model only chooses among the ids this
// returns. Pure over the rows it receives. Whether a row is USABLE (rights, authorizations, not
// deleted) is the single SQL rule of getUsableMedia: the caller passes only usable rows, and the
// service checks again when it writes.

export interface SelectCandidateParams {
  media: readonly MediaCandidate[];
  pieza: { formato: Formato; pilar: string; idea: string };
  reglas: readonly ReglaPlanner[];
  /** Defaults to MAX_CANDIDATOS. */
  limit?: number;
}

/** Words of three or more letters or digits, folded, without repeats. */
function wordsOf(text: string): Set<string> {
  return new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
}

function score(media: MediaCandidate, words: ReadonlySet<string>): number {
  let points = 0;
  const tagWords = new Set(media.etiquetas.flatMap((tag) => [...wordsOf(tag)]));
  for (const word of words) if (tagWords.has(word)) points += 2;
  const descriptionWords = wordsOf(media.descripcion ?? '');
  for (const word of words) if (descriptionWords.has(word)) points += 1;
  return points;
}

/** The client's usable media that fit the piece: right type, no banned visual element, best first, bounded. */
export function selectCandidateMedia({ media, pieza, reglas, limit = MAX_CANDIDATOS }: SelectCandidateParams): MediaCandidate[] {
  const tipos = LIMITES_FORMATO[pieza.formato].tiposMedia;
  const visualBans = reglas.filter((r) => r.tipo === 'elemento_visual').map((r) => r.texto);
  const words = new Set([...wordsOf(pieza.pilar), ...wordsOf(pieza.idea)]);

  return media
    .filter((m) => tipos.includes(m.tipo))
    .filter((m) => {
      const haystack = [...m.etiquetas, m.descripcion ?? ''].join(' ');
      return !visualBans.some((ban) => containsText(haystack, ban));
    })
    .map((m) => ({ m, points: score(m, words) }))
    .sort((a, b) => b.points - a.points || b.m.creado_en.getTime() - a.m.creado_en.getTime() || a.m.id.localeCompare(b.m.id))
    .slice(0, Math.max(0, limit))
    .map(({ m }) => m);
}
