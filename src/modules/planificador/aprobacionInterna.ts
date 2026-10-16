import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { listPiezas, type PiezaRow } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import type { ClienteId } from '../shared/clienteId.js';
import {
  PlanConPiezasPausadasError,
  PlanNoAprobableError,
  PlanNotFoundError,
  PlanPiezasEnOtroEstadoError,
  PlanSinPiezasError,
} from './errors.js';
import { getPlan, PLAN_COLUMNS, type PlanRow } from './planesRepository.js';

// TEMPORARY (until Step 9.3): the client's approval of the weekly plan does not exist yet, but the
// creative director needs approved plans. This is the smallest honest way to reach that state now:
// a SERVICE ONLY, with no route, because the permission matrix forbids NovaCiel approving on behalf
// of the client and a route would ship that to production. It is reached only from a
// development-only script (npm run plan:approve-internal, built in checkpoint E).
//
// Step 9.3 replaces it with the real approval. The Step 5 rule stays: approving the plan and moving
// its pieces from planeada to plan_aprobado happen in the SAME transaction.

export const MOTIVO_APROBACION_INTERNA = 'aprobacion_interna_temporal';

export interface PlanAprobado {
  plan: PlanRow;
  piezas: PiezaRow[];
}

/**
 * Approves a draft plan and moves all its pieces planeada -> plan_aprobado, atomically.
 *
 * LOCK ORDER (the same everywhere): the plan first, then its pieces.
 * Throws PlanNotFoundError (also for another client's plan), PlanNoAprobableError (not a draft),
 * PlanSinPiezasError, PlanConPiezasPausadasError or PlanPiezasEnOtroEstadoError. Any failure rolls
 * everything back.
 */
export async function aprobarPlanInterno(db: Db, clienteId: ClienteId, planId: string, actor: AuditActor): Promise<PlanAprobado> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM planes_semanales WHERE id = $1 AND cliente_id = $2 FOR UPDATE`,
      [planId, clienteId],
    );
    const plan = rows[0];
    if (!plan) throw new PlanNotFoundError();
    if (plan.estado !== 'borrador') throw new PlanNoAprobableError(plan.estado);

    // Pieces second, locked in a stable order.
    await tx.query('SELECT id FROM piezas WHERE plan_id = $1 AND cliente_id = $2 ORDER BY id FOR UPDATE', [planId, clienteId]);
    const piezas = await listPiezas(tx, clienteId, { planId });
    if (piezas.length === 0) throw new PlanSinPiezasError();
    const pausadas = piezas.filter((p) => p.estado === 'pausada').map((p) => p.id);
    if (pausadas.length > 0) throw new PlanConPiezasPausadasError(pausadas);
    const otras = piezas.filter((p) => p.estado !== 'planeada').map((p) => p.id);
    if (otras.length > 0) throw new PlanPiezasEnOtroEstadoError(otras);

    await tx.query(`UPDATE planes_semanales SET estado = 'aprobado' WHERE id = $1 AND cliente_id = $2`, [planId, clienteId]);
    await recordAudit(tx, {
      actor,
      accion: 'aprobar',
      tabla: 'planes_semanales',
      filaId: planId,
      clienteId,
      antes: { estado: 'borrador' },
      despues: { estado: 'aprobado', motivo: MOTIVO_APROBACION_INTERNA, piezas: piezas.length },
    });

    for (const pieza of piezas) {
      await transitionPieza(tx, clienteId, pieza.id, 'plan_aprobado', actor, { motivo: MOTIVO_APROBACION_INTERNA });
    }
    return { plan: (await getPlan(tx, clienteId, planId))!, piezas: await listPiezas(tx, clienteId, { planId }) };
  });
}
