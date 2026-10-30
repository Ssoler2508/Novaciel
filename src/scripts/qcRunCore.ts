import { ejecutarQC, QcDatosInconsistentesError, QcEstadoInvalidoError, QcProduccionCambioError, QcSinFfprobeError, QcSinProduccionError, type QcDeps, type QcResultado } from '../modules/controlCalidad/index.js';
import { PiezaNotFoundError, PlanDescartadoError } from '../modules/piezas/errors.js';
import { listPiezas } from '../modules/piezas/piezasRepository.js';
import { PlanNoAprobadoError, PlanNotFoundError } from '../modules/planificador/errors.js';
import { getPlan } from '../modules/planificador/planesRepository.js';
import type { QcRunArgs } from './qcRunArgs.js';

export interface QcRunResult {
  ok: boolean;
  /** Lines to print: ids, results, check codes and error names only. NEVER the copy of a piece. */
  lines: string[];
}

function describe(done: QcResultado): string[] {
  const { revision, pieza } = done;
  const advertencias = revision.checks.filter((c) => c.resultado === 'advertencia').map((c) => c.codigo);
  const lines = [`Piece ${pieza.id}: QC ${revision.resultado} (production version ${revision.produccion_version}) -> ${pieza.estado}`, `  report ${revision.id}`];
  if (revision.codigos_fallo.length > 0) lines.push(`  failed codes: ${revision.codigos_fallo.join(', ')}`);
  if (advertencias.length > 0) lines.push(`  warnings: ${advertencias.join(', ')}`);
  return lines;
}

export function failureLine(error: unknown): string {
  if (error instanceof PlanNotFoundError) return 'That plan does not exist for this client';
  if (error instanceof PiezaNotFoundError) return 'That piece does not exist for this client';
  if (error instanceof PlanNoAprobadoError) return `The plan is not approved (state ${error.estado})`;
  if (error instanceof PlanDescartadoError) return 'The plan is discarded';
  if (error instanceof QcEstadoInvalidoError) return `A piece in state ${error.estado} has nothing to control (QC needs en_control_calidad)`;
  if (error instanceof QcSinProduccionError) return 'The piece has no production to control (npm run piece:produce)';
  if (error instanceof QcProduccionCambioError) return 'A new production replaced the one being controlled; nothing was stored: run it again';
  if (error instanceof QcDatosInconsistentesError) return `Quality control could not read the ${error.dato} of the production`;
  if (error instanceof QcSinFfprobeError) return 'Quality control needs ffprobe to check a video (check FFPROBE_PATH, see .env.example)';
  return `Quality control failed (${error instanceof Error ? error.name : 'unknown error'})`;
}

/**
 * Runs QC on one piece, or on every piece of a plan waiting in en_control_calidad (also the ones left there
 * in development data), as the system. A piece that fails to be controlled does not stop the rest. A QC
 * that REJECTS a piece is a normal result: the run is ok and the codes are printed.
 */
export async function runQcRun(deps: QcDeps, args: QcRunArgs): Promise<QcRunResult> {
  try {
    if (args.modo === 'pieza') return { ok: true, lines: describe(await ejecutarQC(deps, args.clienteId, args.piezaId, { tipo: 'sistema' })) };

    const plan = await getPlan(deps.db, args.clienteId, args.planId);
    if (!plan) throw new PlanNotFoundError();
    if (plan.estado === 'descartado') throw new PlanDescartadoError();
    if (plan.estado !== 'aprobado') throw new PlanNoAprobadoError(plan.estado);
    const piezas = await listPiezas(deps.db, args.clienteId, { planId: plan.id, estado: 'en_control_calidad' });
    const lines = [`Plan ${plan.id}: ${piezas.length} piece(s) waiting for quality control`];
    let controladas = 0;
    let fallidas = 0;
    for (const pieza of piezas) {
      try {
        lines.push(...describe(await ejecutarQC(deps, args.clienteId, pieza.id, { tipo: 'sistema' })));
        controladas++;
      } catch (error) {
        fallidas++;
        lines.push(`  ${pieza.id} FAILED: ${failureLine(error)}`);
      }
    }
    lines.push(`controlled ${controladas}, failed ${fallidas}`);
    if (controladas === 0 && fallidas === 0) {
      lines.push('Nothing to do: no piece of this plan is waiting in en_control_calidad.');
      return { ok: false, lines };
    }
    return { ok: fallidas === 0, lines };
  } catch (error) {
    return { ok: false, lines: [failureLine(error)] };
  }
}
