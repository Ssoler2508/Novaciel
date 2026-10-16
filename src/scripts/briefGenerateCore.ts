import {
  BriefContextError,
  BriefExistenteError,
  BriefHechoVencidoError,
  BriefMediaNoUsableError,
  BriefObsoletoError,
  generarBrief,
  generarBriefsDelPlan,
  getBriefActual,
  PiezaEstadoInvalidoError,
  type DirectorDeps,
  type GuionView,
} from '../modules/directorCreativo/index.js';
import { SchemaValidationError } from '../modules/ai/generateStructured.js';
import { PiezaNotFoundError, PlanDescartadoError } from '../modules/piezas/errors.js';
import { PlanNoAprobadoError, PlanNotFoundError } from '../modules/planificador/errors.js';
import { PriceNotFoundError } from '../modules/precios/preciosRepository.js';
import { microToUsd, type MicroUsd } from '../modules/presupuesto/money.js';
import { BudgetRefusedError } from '../modules/presupuesto/presupuestoService.js';
import type { BriefGenerateArgs } from './briefGenerateArgs.js';

export interface BriefGenerateResult {
  ok: boolean;
  /** Lines to print. Only ids, counts, error names and costs: NEVER the copy of a brief. */
  lines: string[];
}

function slotsLine(guion: GuionView): string {
  const conMedia = guion.tomas.filter((t) => t.fuente === 'media_real').length;
  const hechos = guion.hecho_ids.length > 0 ? guion.hecho_ids.join(', ') : 'none';
  return `slots ${guion.tomas.length} (with media ${conMedia}, missing ${guion.tomas.length - conMedia}), facts: ${hechos}`;
}

/**
 * Generates the brief of a whole plan, or of one piece, through the director service (actor sistema)
 * and reports it. A `--plan` run that generated nothing (every piece already had its brief) counts
 * as a refusal, so repeating it without `--regenerar` fails.
 */
export async function runBriefGenerate(deps: DirectorDeps, args: BriefGenerateArgs): Promise<BriefGenerateResult> {
  try {
    if (args.modo === 'pieza') {
      const result = await generarBrief(deps, args.clienteId, args.piezaId, { tipo: 'sistema' }, { regenerar: args.regenerar });
      return {
        ok: true,
        lines: [
          `Piece ${args.piezaId}: brief version ${result.guion.version} (${result.pieza.estado}), attempts ${result.generacion.intentos}`,
          `  ${slotsLine(result.guion)}`,
          `cost: USD ${microToUsd(result.generacion.costo)}`,
        ],
      };
    }

    const run = await generarBriefsDelPlan(deps, args.clienteId, args.planId, { tipo: 'sistema' });
    const lines = [`Plan ${run.planId}: ${run.resultados.length} piece(s)`];
    let total = 0n;
    for (const r of run.resultados) {
      if (r.resultado === 'ok') {
        const guion = await getBriefActual(deps.db, args.clienteId, r.piezaId);
        const cost = (r.costo ?? 0n) as MicroUsd;
        total += BigInt(cost);
        lines.push(`  ${r.piezaId} ok v${r.version}: ${guion ? slotsLine(guion) : 'no brief found'}, cost USD ${microToUsd(cost)}`);
      } else if (r.resultado === 'omitida') {
        lines.push(`  ${r.piezaId} skipped: ${r.motivo}`);
      } else {
        lines.push(`  ${r.piezaId} FAILED: ${r.codigo}`);
      }
    }
    const generadas = run.resultados.filter((r) => r.resultado === 'ok').length;
    const fallidas = run.resultados.filter((r) => r.resultado === 'fallida').length;
    lines.push(`generated ${generadas}, failed ${fallidas}${run.detenidoPorPresupuesto ? ', stopped by the budget' : ''}; total cost: USD ${microToUsd(total as MicroUsd)}`);
    if (generadas === 0 && fallidas === 0) {
      lines.push('Nothing to do: no piece is waiting for its brief (use --pieza <id> --regenerar to make a new version).');
      return { ok: false, lines };
    }
    return { ok: fallidas === 0, lines };
  } catch (error) {
    return { ok: false, lines: [failureLine(error)] };
  }
}

function failureLine(error: unknown): string {
  if (error instanceof PlanNotFoundError) return 'That plan does not exist for this client';
  if (error instanceof PiezaNotFoundError) return 'That piece does not exist for this client';
  if (error instanceof PlanNoAprobadoError) return `The plan is not approved (state ${error.estado}); approve it first (npm run plan:approve-internal)`;
  if (error instanceof PlanDescartadoError) return 'The plan is discarded';
  if (error instanceof PiezaEstadoInvalidoError) return `A brief cannot be made for a piece in state ${error.estado}`;
  if (error instanceof BriefExistenteError) return `The piece already has a current brief (version ${error.version}). Use --regenerar to make a new version.`;
  if (error instanceof BudgetRefusedError) return `Budget refused: ${error.reason}`;
  if (error instanceof PriceNotFoundError) return 'No price for the model: enter it first (npm run set-price)';
  if (error instanceof SchemaValidationError) return 'The model output was invalid after 2 attempts (an alert was raised)';
  if (error instanceof BriefHechoVencidoError) return `${error.hechoIds.length} fact(s) used by the brief are no longer valid: run it again`;
  if (error instanceof BriefMediaNoUsableError) return `${error.mediaIds.length} media item(s) chosen by the brief are no longer usable: run it again`;
  if (error instanceof BriefObsoletoError) return 'The piece changed while the brief was being written: run it again';
  if (error instanceof BriefContextError) return `Profile problem: ${error.field}`;
  return `Brief generation failed (${error instanceof Error ? error.name : 'unknown error'})`;
}
