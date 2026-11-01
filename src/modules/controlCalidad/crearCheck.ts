import { CATALOGO, type CodigoQC } from './catalogo.js';
import type { CheckQC, Parametros } from './tipos.js';

/** A closed identifier: lowercase letters, digits and `_ . : -` (this also covers ids and uuids). */
const IDENTIFICADOR_CERRADO = /^[a-z0-9_.:-]{1,80}$/;

/** A parameter that could carry text of the client. Never includes the offending value. */
export class ParametroInseguroError extends Error {
  constructor(readonly clave: string) {
    super(`Unsafe quality-control parameter: ${clave}`);
    this.name = 'ParametroInseguroError';
  }
}

function esSeguro(valor: unknown): boolean {
  if (typeof valor === 'number') return Number.isFinite(valor);
  if (typeof valor === 'boolean') return true;
  if (typeof valor === 'string') return IDENTIFICADOR_CERRADO.test(valor);
  if (Array.isArray(valor)) return valor.every((v) => typeof v !== 'object' && esSeguro(v));
  return false;
}

/**
 * Builds a check from the catalogue. `cumple` true gives `pasa`; false gives `no_pasa` for a blocking
 * code and `advertencia` for a warning code. `parametros` hold numbers, booleans and closed identifiers
 * only: anything else throws, so a free text can never reach a report.
 */
export function crearCheck(codigo: CodigoQC, cumple: boolean, parametros: Parametros = {}): CheckQC {
  for (const [clave, valor] of Object.entries(parametros)) {
    if (!esSeguro(valor)) throw new ParametroInseguroError(clave);
  }
  const { severidad, motivo } = CATALOGO[codigo];
  return {
    codigo,
    resultado: cumple ? 'pasa' : severidad === 'bloqueante' ? 'no_pasa' : 'advertencia',
    severidad,
    motivo: cumple ? 'Cumple.' : motivo,
    parametros,
  };
}
