import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import {
  createCliente,
  createPerfilMarca,
  createPieza,
  createPlanSemanal,
  createUsuario,
  insertHistorial,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { getHistorial, getPieza, listPiezas, pausarPieza, transitionPieza } from '../piezas/index.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { aprobarPlanInterno, MOTIVO_APROBACION_INTERNA } from './aprobacionInterna.js';
import {
  PlanConPiezasPausadasError,
  PlanNoAprobableError,
  PlanNotFoundError,
  PlanPiezasEnOtroEstadoError,
  PlanSinPiezasError,
} from './errors.js';
import { getPlan } from './planesRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;

async function draftPlan(db: Db, pieces = 3) {
  const cliente = await createCliente(db);
  const perfil = await createPerfilMarca(db, { clienteId: cliente.id });
  const plan = await createPlanSemanal(db, { clienteId: cliente.id, perfilMarcaId: perfil.id });
  const piezas = [];
  for (let i = 0; i < pieces; i++) piezas.push(await createPieza(db, { clienteId: cliente.id, planId: plan.id }));
  return { clienteId: asClienteId(cliente.id), plan, piezas };
}

const auditCount = async (db: Db, clienteId: string) => Number((await db.query('SELECT count(*) AS n FROM auditoria WHERE cliente_id = $1', [clienteId])).rows[0].n);

describe('aprobarPlanInterno (TEMPORARY until Step 9.3)', () => {
  it('approves the plan and moves every piece to plan_aprobado, with the motivo in history and audit', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db);
      const w = await draftPlan(db);
      const result = await aprobarPlanInterno(db, w.clienteId, w.plan.id, { tipo: 'usuario', usuarioId: usuario.id });

      expect(result.plan.estado).toBe('aprobado');
      expect(result.piezas).toHaveLength(3);
      expect(result.piezas.every((p) => p.estado === 'plan_aprobado' && p.version_estado === 1)).toBe(true);

      for (const pieza of w.piezas) {
        const history = await getHistorial(db, w.clienteId, pieza.id);
        expect(history).toHaveLength(2);
        expect(history[1]).toMatchObject({
          version: 1,
          desde: 'planeada',
          hacia: 'plan_aprobado',
          motivo: MOTIVO_APROBACION_INTERNA,
          actor_tipo: 'usuario',
          actor_usuario_id: usuario.id,
        });
        const audit = (await auditRowsFor(db, 'piezas', pieza.id)).filter((a) => a.accion === 'cambiar_estado');
        expect(audit).toHaveLength(1);
        expect(audit[0]!.datos_despues).toMatchObject({ estado: 'plan_aprobado', motivo: MOTIVO_APROBACION_INTERNA });
      }
      const planAudit = await auditRowsFor(db, 'planes_semanales', w.plan.id);
      expect(planAudit.map((a) => a.accion)).toEqual(['aprobar']);
      expect(planAudit[0]).toMatchObject({ datos_antes: { estado: 'borrador' }, datos_despues: { estado: 'aprobado', motivo: MOTIVO_APROBACION_INTERNA, piezas: 3 } });
    });
  });

  it('works for the system actor too', async () => {
    await withTestTransaction(async (db) => {
      const w = await draftPlan(db, 1);
      const result = await aprobarPlanInterno(db, w.clienteId, w.plan.id, SISTEMA);
      expect(result.piezas[0]!.estado).toBe('plan_aprobado');
    });
  });

  it('refuses a plan of another client with the same error as a missing plan, touching nothing', async () => {
    await withTestTransaction(async (db) => {
      const a = await draftPlan(db);
      const b = await draftPlan(db);
      const auditBefore = await auditCount(db, b.clienteId);
      await expect(aprobarPlanInterno(db, a.clienteId, b.plan.id, SISTEMA)).rejects.toBeInstanceOf(PlanNotFoundError);
      await expect(aprobarPlanInterno(db, a.clienteId, '00000000-0000-4000-8000-000000000000', SISTEMA)).rejects.toBeInstanceOf(PlanNotFoundError);
      expect((await getPlan(db, b.clienteId, b.plan.id))!.estado).toBe('borrador');
      expect((await listPiezas(db, b.clienteId)).every((p) => p.estado === 'planeada')).toBe(true);
      expect(await auditCount(db, b.clienteId)).toBe(auditBefore);
    });
  });

  it.each(['aprobado', 'propuesto', 'descartado'] as const)('refuses a plan that is %s', async (estado) => {
    await withTestTransaction(async (db) => {
      const w = await draftPlan(db);
      await db.query('UPDATE planes_semanales SET estado = $2 WHERE id = $1', [w.plan.id, estado]);
      await expect(aprobarPlanInterno(db, w.clienteId, w.plan.id, SISTEMA)).rejects.toMatchObject({ name: PlanNoAprobableError.name, estado });
    });
  });

  it('refuses a plan without pieces', async () => {
    await withTestTransaction(async (db) => {
      const w = await draftPlan(db, 0);
      await expect(aprobarPlanInterno(db, w.clienteId, w.plan.id, SISTEMA)).rejects.toBeInstanceOf(PlanSinPiezasError);
    });
  });

  it('refuses a plan with a paused piece (it would be left behind), and one in another state', async () => {
    await withTestTransaction(async (db) => {
      const w = await draftPlan(db);
      await pausarPieza(db, w.clienteId, w.piezas[0]!.id, SISTEMA);
      await expect(aprobarPlanInterno(db, w.clienteId, w.plan.id, SISTEMA)).rejects.toMatchObject({ name: PlanConPiezasPausadasError.name, piezaIds: [w.piezas[0]!.id] });

      const v = await draftPlan(db);
      await transitionPieza(db, v.clienteId, v.piezas[1]!.id, 'plan_aprobado', SISTEMA);
      await expect(aprobarPlanInterno(db, v.clienteId, v.plan.id, SISTEMA)).rejects.toMatchObject({ name: PlanPiezasEnOtroEstadoError.name, piezaIds: [v.piezas[1]!.id] });
      expect((await getPlan(db, v.clienteId, v.plan.id))!.estado).toBe('borrador');
    });
  });

  it('is atomic: a failure on the last piece leaves the plan a draft and every piece planeada', async () => {
    await withTestTransaction(async (db) => {
      const w = await draftPlan(db, 3);
      const last = [...w.piezas].sort((a, b) => a.fecha_hora.getTime() - b.fecha_hora.getTime() || a.id.localeCompare(b.id)).at(-1)!;
      // A stray history row for the last piece makes its transition fail after the others succeeded.
      await insertHistorial(db, last.id, w.clienteId, { version: 1, desde: 'planeada', hacia: 'plan_aprobado', actor: SISTEMA });
      const auditBefore = await auditCount(db, w.clienteId);

      await expect(aprobarPlanInterno(db, w.clienteId, w.plan.id, SISTEMA)).rejects.toBeInstanceOf(Error);

      expect((await getPlan(db, w.clienteId, w.plan.id))!.estado).toBe('borrador');
      for (const pieza of w.piezas) expect((await getPieza(db, w.clienteId, pieza.id))!.estado).toBe('planeada');
      expect(await auditCount(db, w.clienteId)).toBe(auditBefore);
    });
  });

  it('a second approval is refused: approved is final here', async () => {
    await withTestTransaction(async (db) => {
      const w = await draftPlan(db, 2);
      await aprobarPlanInterno(db, w.clienteId, w.plan.id, SISTEMA);
      await expect(aprobarPlanInterno(db, w.clienteId, w.plan.id, SISTEMA)).rejects.toBeInstanceOf(PlanNoAprobableError);
    });
  });
});
