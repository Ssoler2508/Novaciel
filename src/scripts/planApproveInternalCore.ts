import type { Db } from '../db/types.js';
import {
  aprobarPlanInterno,
  PlanConPiezasPausadasError,
  PlanNoAprobableError,
  PlanNotFoundError,
  PlanPiezasEnOtroEstadoError,
  PlanSinPiezasError,
} from '../modules/planificador/index.js';
import type { PlanApproveInternalArgs } from './planApproveInternalArgs.js';

// TEMPORARY until Step 9: this development script is the only way to approve a plan now (there is no
// HTTP route: the matrix forbids NovaCiel approving for the client). The client's approval replaces it.

export interface PlanApproveInternalResult {
  ok: boolean;
  /** Lines to print. Only ids, states and counts. */
  lines: string[];
}

/** Approves a draft plan and moves its pieces to plan_aprobado, as the system, and reports it. */
export async function runPlanApproveInternal(db: Db, args: PlanApproveInternalArgs): Promise<PlanApproveInternalResult> {
  try {
    const { plan, piezas } = await aprobarPlanInterno(db, args.clienteId, args.planId, { tipo: 'sistema' });
    return {
      ok: true,
      lines: [
        `Plan ${plan.id} is now ${plan.estado} (internal approval, TEMPORARY until Step 9): ${piezas.length} piece(s) moved to plan_aprobado`,
        ...piezas.map((p) => `  ${p.id} ${p.estado}`),
      ],
    };
  } catch (error) {
    return { ok: false, lines: [failureLine(error)] };
  }
}

function failureLine(error: unknown): string {
  if (error instanceof PlanNotFoundError) return 'That plan does not exist for this client';
  if (error instanceof PlanNoAprobableError) return `Only a draft plan can be approved (state ${error.estado})`;
  if (error instanceof PlanSinPiezasError) return 'The plan has no pieces to approve';
  if (error instanceof PlanConPiezasPausadasError) return `${error.piezaIds.length} piece(s) are paused (${error.piezaIds.join(', ')}): resume them first`;
  if (error instanceof PlanPiezasEnOtroEstadoError) return `${error.piezaIds.length} piece(s) are not in planeada (${error.piezaIds.join(', ')})`;
  return `Plan approval failed (${error instanceof Error ? error.name : 'unknown error'})`;
}
