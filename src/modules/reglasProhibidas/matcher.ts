import { containsText, containsWord } from '../planificador/textMatch.js';

// The one definition of "this text breaks a banned rule", shared by the planner, the creative director
// and quality control. Accent- and case-insensitive: palabra = a whole word, promesa and tema = anywhere.
// `elemento_visual` is about pictures, not text, so it never matches here.

export interface ReglaDeTexto {
  tipo: 'promesa' | 'tema' | 'palabra' | 'elemento_visual';
  texto: string;
}

export function reglaViolada(texto: string, regla: ReglaDeTexto): boolean {
  if (regla.tipo === 'palabra') return containsWord(texto, regla.texto);
  if (regla.tipo === 'promesa' || regla.tipo === 'tema') return containsText(texto, regla.texto);
  return false;
}
