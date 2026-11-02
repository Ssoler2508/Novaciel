import { checksReglas } from '../controlCalidad/reglas.js';
import { checksCifras } from '../controlCalidad/cifras.js';
import type { CampoPublicado } from '../controlCalidad/tipos.js';
import { mentionsAiGenerationRequest } from '../directorCreativo/detectors.js';
import { LIMITES_TEXTO } from '../directorCreativo/limits.js';
import type { HechoPlanner } from '../planificador/types.js';
import type { ReglaDeTexto } from '../reglasProhibidas/matcher.js';
import { LocucionTextoInvalidoError, type LocucionTextoReason } from './errors.js';

// Text preparation of a scene's voice-over (Step 7d). PURE. The spoken text is the brief's rendered
// `voz_en_off`: rule 2 and the banned rules apply to it exactly as to on-screen text, because it reuses
// the same checks of quality control (cifras.ts, reglas.ts). Errors carry reason codes, never the text.

export interface TextoLocucion {
  /** NFC, whitespace collapsed, trimmed: exactly what is sent to the provider and subtitled. */
  texto: string;
  /** Code points of `texto`: what the provider bills (VERIFY: characters or credits). */
  caracteres: number;
}

export interface EntradaTextoLocucion {
  /** The rendered `voz_en_off` (fact tokens already replaced). */
  texto: string;
  /** The model's `voz_en_off` with `{{hecho:id}}` tokens: it says which facts the text cites. */
  modelo: string;
  hechos: readonly HechoPlanner[];
  reglas: readonly ReglaDeTexto[];
  ahora: Date;
  /** The instant the piece will be published (`fecha_hora`). */
  instantePieza: Date;
}

const ORDEN: readonly LocucionTextoReason[] = [
  'token_sin_reemplazar',
  'demasiado_largo',
  'pide_imagen_ia',
  'cifra_libre',
  'hecho_texto_cambiado',
  'hecho_no_vigente',
  'regla_prohibida_palabra',
  'regla_prohibida_promesa',
  'regla_prohibida_tema',
];

/** NFC, every run of whitespace becomes one space, ends trimmed. */
export function normalizarTextoLocucion(texto: string): string {
  return texto.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * The text to speak for one scene, or `null` when the scene has no voice (empty or only spaces).
 * Throws LocucionTextoInvalidoError listing every reason that applies.
 */
export function prepararTextoLocucion(entrada: EntradaTextoLocucion): TextoLocucion | null {
  const texto = normalizarTextoLocucion(entrada.texto);
  if (texto === '') return null;

  const fallos = new Set<LocucionTextoReason>();
  const caracteres = [...texto].length;
  if (texto.includes('{{') || texto.includes('}}')) fallos.add('token_sin_reemplazar');
  if (caracteres > LIMITES_TEXTO.vozEnOff) fallos.add('demasiado_largo');
  if (mentionsAiGenerationRequest(texto)) fallos.add('pide_imagen_ia');

  const campo: CampoPublicado = { campo: 'texto_en_pantalla', indice: 0, texto, modelo: entrada.modelo };
  const checks = [
    ...checksCifras({ campos: [campo], hechos: entrada.hechos, ahora: entrada.ahora, instantePieza: entrada.instantePieza }),
    ...checksReglas([campo], entrada.reglas),
  ];
  for (const check of checks) if (check.resultado !== 'pasa') fallos.add(check.codigo as LocucionTextoReason);

  if (fallos.size > 0) {
    const motivos = ORDEN.filter((r) => fallos.has(r));
    throw new LocucionTextoInvalidoError(motivos[0]!, motivos);
  }
  return { texto, caracteres };
}
