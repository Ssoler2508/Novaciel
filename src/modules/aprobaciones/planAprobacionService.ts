import { z } from 'zod';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit } from '../auditoria/recordAudit.js';
import { listPiezas, type PiezaRow } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import {
  PlanConPiezasPausadasError,
  PlanNotFoundError,
  PlanPiezasEnOtroEstadoError,
  PlanSinPiezasError,
} from '../planificador/errors.js';
import { getPlan, PLAN_COLUMNS, type PlanRow } from '../planificador/planesRepository.js';
import type { ClienteId } from '../shared/clienteId.js';
import { esPersonalNovaciel, requireAction, rolParaNivel, type AprobadorActor } from './actor.js';
import { getHuellaPlan } from './aprobacionesRepository.js';
import type { AprobacionesDeps } from './aprobacionesService.js';
import { AprobacionInvalidaError, HuellaDesactualizadaError, PermisoDenegadoError, PlanNoDecidibleError, PlanNoProponibleError } from './errors.js';

// The client's approval of the weekly plan (ADR-05, decision 7). It replaces the TEMPORARY
// aprobarPlanInterno: NovaCiel proposes (borrador -> propuesto) and the CLIENT decides on the plan
// fingerprint. LOCK ORDER (the same everywhere): the plan first, then its pieces.

export const MOTIVO_APROBACION_CLIENTE = 'aprobacion_plan_cliente';

const planDecisionSchema = z.object({
  decision: z.enum(['aprobado', 'cambios', 'rechazado']),
  /** The fingerprint the approver was shown, lower-case hex (plan_huella). */
  huellaVista: z.string().regex(/^[0-9a-f]{64}$/),
  motivo: z.enum(['ideas', 'fechas', 'formatos', 'pilares', 'otro']).optional(),
  /** CLIENT DATA: stored, never logged or audited. */
  comentario: z.string().trim().min(1).max(2000).optional(),
  dispositivo: z.string().trim().min(1).max(40).optional(),
});
export type PlanDecisionInput = z.input<typeof planDecisionSchema>;

export interface PlanConPiezas {
  plan: PlanRow;
  piezas: PiezaRow[];
}

const ESTADO_PLAN_TRAS = { aprobado: 'aprobado', cambios: 'borrador', rechazado: 'descartado' } as const;

/** Locks the plan, then its pieces in a stable order. */
async function lockPlan(tx: Db, clienteId: ClienteId, planId: string): Promise<{ plan: PlanRow; piezas: PiezaRow[] }> {
  const { rows } = await tx.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM planes_semanales WHERE id = $1 AND cliente_id = $2 FOR UPDATE`, [planId, clienteId]);
  const plan = rows[0];
  if (!plan) throw new PlanNotFoundError();
  await tx.query('SELECT id FROM piezas WHERE plan_id = $1 AND cliente_id = $2 ORDER BY id FOR UPDATE', [planId, clienteId]);
  return { plan, piezas: await listPiezas(tx, clienteId, { planId }) };
}

/**
 * NovaCiel shows the plan to the client: borrador -> propuesto. Every piece must still be planeada.
 * With a `recordatorios` port, the client's reminders are scheduled in the same transaction.
 */
export async function proponerPlan(deps: AprobacionesDeps, clienteId: ClienteId, planId: string, actor: AprobadorActor): Promise<PlanConPiezas> {
  requireAction(actor, 'manage_plans', clienteId);
  if (!esPersonalNovaciel(actor)) throw new PermisoDenegadoError('manage_plans');
  return runInTransaction(deps.db, async (tx) => {
    const { plan, piezas } = await lockPlan(tx, clienteId, planId);
    if (plan.estado !== 'borrador') throw new PlanNoProponibleError(plan.estado);
    if (piezas.length === 0) throw new PlanSinPiezasError();
    const pausadas = piezas.filter((p) => p.estado === 'pausada').map((p) => p.id);
    if (pausadas.length > 0) throw new PlanConPiezasPausadasError(pausadas);
    const otras = piezas.filter((p) => p.estado !== 'planeada').map((p) => p.id);
    if (otras.length > 0) throw new PlanPiezasEnOtroEstadoError(otras);

    await tx.query(`UPDATE planes_semanales SET estado = 'propuesto' WHERE id = $1 AND cliente_id = $2`, [planId, clienteId]);
    await recordAudit(tx, {
      actor: { tipo: 'usuario', usuarioId: actor.usuarioId },
      accion: 'proponer',
      tabla: 'planes_semanales',
      filaId: planId,
      clienteId,
      antes: { estado: 'borrador' },
      despues: { estado: 'propuesto', piezas: piezas.length },
    });
    // The client now has to decide: remind them (spec 11.3) before the first piece of the week is due.
    if (deps.recordatorios) {
      await deps.recordatorios.programar(tx, {
        clienteId,
        tipo: 'plan',
        objetoId: planId,
        plazo: new Date(Math.min(...piezas.map((p) => p.fecha_hora.getTime()))),
        zona: plan.zona_horaria,
        referencia: await getHuellaPlan(tx, clienteId, planId),
      });
    }
    return { plan: (await getPlan(tx, clienteId, planId))!, piezas };
  });
}

/**
 * The client decides on a proposed plan, on the fingerprint they were shown.
 *   aprobado  the plan becomes aprobado and every piece moves planeada -> plan_aprobado, in the SAME
 *             transaction (the Step 5 rule), with the client user as the actor;
 *   cambios   the plan goes back to borrador;
 *   rechazado the plan is discarded.
 * A stale fingerprint is refused (409). Audit rows carry ids, the decision and the fingerprint; never
 * the comment.
 */
export async function decidirPlan(
  deps: { db: Db },
  clienteId: ClienteId,
  planId: string,
  actor: AprobadorActor,
  input: PlanDecisionInput,
): Promise<PlanConPiezas> {
  const parsed = planDecisionSchema.safeParse(input);
  if (!parsed.success) throw new AprobacionInvalidaError([...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? 'input')))]);
  const d = parsed.data;
  const rol = rolParaNivel(actor, 'cliente', clienteId);
  if ((d.decision === 'aprobado') === (d.motivo !== undefined)) throw new AprobacionInvalidaError(['motivo']);

  return runInTransaction(deps.db, async (tx) => {
    const { plan, piezas } = await lockPlan(tx, clienteId, planId);
    if (plan.estado !== 'propuesto') throw new PlanNoDecidibleError(plan.estado);
    const huella = await getHuellaPlan(tx, clienteId, planId);
    if (d.huellaVista !== huella) throw new HuellaDesactualizadaError(planId);

    const quien = { tipo: 'usuario', usuarioId: actor.usuarioId } as const;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO aprobaciones_plan (cliente_id, plan_id, huella_plan, decision, usuario_id, rol_id, motivo, comentario, dispositivo)
       VALUES ($1, $2, decode($3, 'hex'), $4, $5, (SELECT id FROM roles WHERE codigo = $6), $7, $8, $9) RETURNING id`,
      [clienteId, planId, huella, d.decision, actor.usuarioId, rol, d.motivo ?? null, d.comentario ?? null, d.dispositivo ?? null],
    );
    const nuevoEstado = ESTADO_PLAN_TRAS[d.decision];
    await tx.query('UPDATE planes_semanales SET estado = $3 WHERE id = $1 AND cliente_id = $2', [planId, clienteId, nuevoEstado]);
    await recordAudit(tx, {
      actor: quien,
      accion: 'decidir',
      tabla: 'aprobaciones_plan',
      filaId: rows[0]!.id,
      clienteId,
      antes: { estado: 'propuesto' },
      despues: { plan_id: planId, decision: d.decision, estado: nuevoEstado, huella_plan: huella, piezas: piezas.length, rol },
    });
    if (d.decision === 'aprobado') {
      for (const pieza of piezas) {
        await transitionPieza(tx, clienteId, pieza.id, 'plan_aprobado', quien, { motivo: MOTIVO_APROBACION_CLIENTE });
      }
    }
    return { plan: (await getPlan(tx, clienteId, planId))!, piezas: await listPiezas(tx, clienteId, { planId }) };
  });
}
