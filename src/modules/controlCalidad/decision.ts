import type { CodigoQC } from './catalogo.js';
import type { CheckQC, ResultadoQC } from './tipos.js';

/** Rejected if and only if a blocking check did not pass. Warnings never reject. */
export function decidirResultadoQC(checks: readonly CheckQC[]): ResultadoQC {
  if (checks.length === 0) throw new Error('A quality-control run needs at least one check');
  return checks.some((c) => c.resultado === 'no_pasa') ? 'rechazado' : 'aprobado';
}

/** The codes of the checks that did not pass, as stored in `revisiones_calidad.codigos_fallo`. */
export function codigosDeFallo(checks: readonly CheckQC[]): CodigoQC[] {
  return checks.filter((c) => c.resultado === 'no_pasa').map((c) => c.codigo);
}
