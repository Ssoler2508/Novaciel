import type { RegistroAprobacion } from './types.js';

// Pure. Spec 11.3: at most 2 change rounds per piece; on the 3rd the piece goes to a NovaCiel person
// (ADR-05, decision 5).

export const MAX_RONDAS_CAMBIOS = 2;

/**
 * Change rounds of a piece: the change requests of the CLIENT, over all its productions. Internal
 * change requests and NovaCiel pull-backs (aprobada/programada -> con_cambios) never count.
 */
export function rondasDeCambios(registros: readonly RegistroAprobacion[]): { rondas: number; maximo: number } {
  const rondas = registros.filter((r) => r.nivel === 'cliente' && r.decision === 'cambios').length;
  return { rondas, maximo: MAX_RONDAS_CAMBIOS };
}

export interface DecisionEscalada {
  rondas: number;
  /** The piece is past the allowed rounds: a NovaCiel person owns it. Derived, never stored. */
  escalada: boolean;
  /** True only when the count is exactly the first one over the limit, so NovaCiel is told once. */
  notificarAhora: boolean;
}

export function decidirEscalada(registros: readonly RegistroAprobacion[]): DecisionEscalada {
  const { rondas, maximo } = rondasDeCambios(registros);
  return { rondas, escalada: rondas > maximo, notificarAhora: rondas === maximo + 1 };
}
