import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { createActores, createCliente, createPieza, createPlanSemanal, createUsuarioConRol, moverPieza } from '../../../tests/utils/factories/index.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import type { Db } from '../../db/types.js';
import { listPiezas } from '../piezas/piezasRepository.js';
import {
  PlanConPiezasPausadasError,
  PlanNotFoundError,
  PlanPiezasEnOtroEstadoError,
  PlanSinPiezasError,
} from '../planificador/errors.js';
import { getPlan } from '../planificador/planesRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import { getHuellaPlan } from './aprobacionesRepository.js';
import {
  AprobacionInvalidaError,
  HuellaDesactualizadaError,
  PermisoDenegadoError,
  PlanNoDecidibleError,
  PlanNoProponibleError,
} from './errors.js';
import { decidirPlan, proponerPlan } from './planAprobacionService.js';

const COMENTARIO = 'Comentario ficticio: prefiero otras ideas para el jueves';

async function draft(db: Db, pieces = 3) {
  const cliente = await createCliente(db);
  const clienteId = asClienteId(cliente.id);
  const plan = await createPlanSemanal(db, { clienteId: cliente.id });
  for (let i = 0; i < pieces; i++) await createPieza(db, { clienteId: cliente.id, planId: plan.id });
  return { clienteId, planId: plan.id, actores: await createActores(db, cliente.id) };
}

async function proposed(db: Db, pieces = 3) {
  const x = await draft(db, pieces);
  await proponerPlan({ db }, x.clienteId, x.planId, x.actores.novaciel);
  return { ...x, huella: await getHuellaPlan(db, x.clienteId, x.planId) };
}

describe('proponerPlan', () => {
  it('moves a draft plan to propuesto and audits it', async () => {
    await withTestTransaction(async (db) => {
      const x = await draft(db);
      const result = await proponerPlan({ db }, x.clienteId, x.planId, x.actores.novaciel);
      expect(result.plan.estado).toBe('propuesto');
      expect(result.piezas).toHaveLength(3);
      const audit = (await auditRowsFor(db, 'planes_semanales', x.planId)).filter((a) => a.accion === 'proponer');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ cliente_id: x.clienteId, datos_antes: { estado: 'borrador' }, datos_despues: { estado: 'propuesto', piezas: 3 } });
    });
  });

  it('is NovaCiel only, and needs a draft with pieces that are all planeada and not paused', async () => {
    await withTestTransaction(async (db) => {
      const x = await draft(db);
      await expect(proponerPlan({ db }, x.clienteId, x.planId, x.actores.cliente)).rejects.toBeInstanceOf(PermisoDenegadoError);
      await expect(proponerPlan({ db }, x.clienteId, '123e4567-e89b-42d3-a456-426614174000', x.actores.novaciel)).rejects.toBeInstanceOf(PlanNotFoundError);
      const empty = await draft(db, 0);
      await expect(proponerPlan({ db }, empty.clienteId, empty.planId, empty.actores.novaciel)).rejects.toBeInstanceOf(PlanSinPiezasError);

      const withPaused = await draft(db, 1);
      const [pieza] = await listPiezas(db, withPaused.clienteId, { planId: withPaused.planId });
      await moverPieza(db, pieza!.id, 'pausada');
      await expect(proponerPlan({ db }, withPaused.clienteId, withPaused.planId, withPaused.actores.novaciel)).rejects.toBeInstanceOf(PlanConPiezasPausadasError);

      const advanced = await draft(db, 1);
      const [other] = await listPiezas(db, advanced.clienteId, { planId: advanced.planId });
      await moverPieza(db, other!.id, 'plan_aprobado');
      await expect(proponerPlan({ db }, advanced.clienteId, advanced.planId, advanced.actores.novaciel)).rejects.toBeInstanceOf(PlanPiezasEnOtroEstadoError);

      await proponerPlan({ db }, x.clienteId, x.planId, x.actores.novaciel);
      await expect(proponerPlan({ db }, x.clienteId, x.planId, x.actores.novaciel)).rejects.toBeInstanceOf(PlanNoProponibleError);
    });
  });
});

describe('decidirPlan', () => {
  it('approval: the plan is aprobado and every piece is plan_aprobado in the same transaction, acted by the client user', async () => {
    await withTestTransaction(async (db) => {
      const x = await proposed(db);
      const result = await decidirPlan({ db }, x.clienteId, x.planId, x.actores.cliente, { decision: 'aprobado', huellaVista: x.huella, dispositivo: 'movil · Safari' });
      expect(result.plan.estado).toBe('aprobado');
      expect(result.piezas.every((p) => p.estado === 'plan_aprobado')).toBe(true);
      const history = await db.query(
        `SELECT actor_usuario_id, motivo FROM historial_estados_pieza WHERE cliente_id = $1 AND hacia = 'plan_aprobado'`,
        [x.clienteId],
      );
      expect(history.rows).toHaveLength(3);
      expect(history.rows.every((r) => r.actor_usuario_id === x.actores.ids.cliente && r.motivo === 'aprobacion_plan_cliente')).toBe(true);
      const record = await db.query('SELECT decision, encode(huella_plan, $2) AS huella FROM aprobaciones_plan WHERE plan_id = $1', [x.planId, 'hex']);
      expect(record.rows).toEqual([{ decision: 'aprobado', huella: x.huella }]);
    });
  });

  it('changes requested sends the plan back to borrador; rejection discards it; the audit never holds the comment', async () => {
    await withTestTransaction(async (db) => {
      const a = await proposed(db);
      const changes = await decidirPlan({ db }, a.clienteId, a.planId, a.actores.cliente, { decision: 'cambios', huellaVista: a.huella, motivo: 'ideas', comentario: COMENTARIO });
      expect(changes.plan.estado).toBe('borrador');
      expect(changes.piezas.every((p) => p.estado === 'planeada')).toBe(true);
      const audit = (await auditRowsFor(db, 'aprobaciones_plan', (await db.query('SELECT id FROM aprobaciones_plan WHERE plan_id = $1', [a.planId])).rows[0]!.id)).filter((r) => r.accion === 'decidir');
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain('otras ideas');
      expect(audit[0]!.datos_despues).toMatchObject({ decision: 'cambios', estado: 'borrador', huella_plan: a.huella });
      // It can be proposed again.
      await expect(proponerPlan({ db }, a.clienteId, a.planId, a.actores.novaciel)).resolves.toMatchObject({ plan: { estado: 'propuesto' } });

      const b = await proposed(db);
      const rejected = await decidirPlan({ db }, b.clienteId, b.planId, b.actores.cliente, { decision: 'rechazado', huellaVista: b.huella, motivo: 'otro' });
      expect(rejected.plan.estado).toBe('descartado');
    });
  });

  it('refuses a stale fingerprint: the plan changed while the approver was looking, and nothing changes', async () => {
    await withTestTransaction(async (db) => {
      const x = await proposed(db);
      await db.query(`UPDATE piezas SET idea = 'Idea cambiada ficticia' WHERE plan_id = $1 AND id = (SELECT id FROM piezas WHERE plan_id = $1 ORDER BY id LIMIT 1)`, [x.planId]);
      await expect(
        decidirPlan({ db }, x.clienteId, x.planId, x.actores.cliente, { decision: 'aprobado', huellaVista: x.huella }),
      ).rejects.toBeInstanceOf(HuellaDesactualizadaError);
      expect((await getPlan(db, x.clienteId, x.planId))!.estado).toBe('propuesto');
      expect((await db.query('SELECT 1 FROM aprobaciones_plan WHERE plan_id = $1', [x.planId])).rows).toHaveLength(0);
    });
  });

  it('is refused for NovaCiel (also with a client role), for colaborador_cliente, for another client, and in the wrong plan state', async () => {
    await withTestTransaction(async (db) => {
      const x = await proposed(db);
      const input = { decision: 'aprobado', huellaVista: x.huella } as const;
      await expect(decidirPlan({ db }, x.clienteId, x.planId, x.actores.novaciel, input)).rejects.toBeInstanceOf(PermisoDenegadoError);
      const mixed = { usuarioId: x.actores.ids.novaciel, roles: [...x.actores.novaciel.roles, { rol: 'aprobador_cliente', clienteId: x.clienteId }] };
      await expect(decidirPlan({ db }, x.clienteId, x.planId, mixed, input)).rejects.toBeInstanceOf(PermisoDenegadoError);
      const colab = { usuarioId: (await createUsuarioConRol(db, 'colaborador_cliente', x.clienteId)).id, roles: [{ rol: 'colaborador_cliente', clienteId: x.clienteId }] };
      await expect(decidirPlan({ db }, x.clienteId, x.planId, colab, input)).rejects.toBeInstanceOf(PermisoDenegadoError);
      const other = await proposed(db);
      await expect(decidirPlan({ db }, other.clienteId, x.planId, other.actores.cliente, input)).rejects.toBeInstanceOf(PlanNotFoundError);
      await expect(decidirPlan({ db }, x.clienteId, x.planId, x.actores.cliente, { decision: 'cambios', huellaVista: x.huella })).rejects.toBeInstanceOf(AprobacionInvalidaError);

      await decidirPlan({ db }, x.clienteId, x.planId, x.actores.cliente, input);
      await expect(decidirPlan({ db }, x.clienteId, x.planId, x.actores.cliente, input)).rejects.toBeInstanceOf(PlanNoDecidibleError);
      const notProposed = await draft(db);
      await expect(decidirPlan({ db }, notProposed.clienteId, notProposed.planId, notProposed.actores.cliente, { decision: 'aprobado', huellaVista: x.huella })).rejects.toBeInstanceOf(PlanNoDecidibleError);
    });
  });

  it('is atomic: if a piece cannot move, the plan stays proposed and no record is kept', async () => {
    await withTestTransaction(async (db) => {
      const x = await proposed(db, 2);
      const [first] = await listPiezas(db, x.clienteId, { planId: x.planId });
      // A piece that is not planeada any more (inconsistent data): the transition planeada -> plan_aprobado fails.
      await db.query(`ALTER TABLE piezas DISABLE TRIGGER USER`);
      await db.query(`UPDATE piezas SET estado = 'cerrada' WHERE id = $1`, [first!.id]);
      await db.query(`ALTER TABLE piezas ENABLE TRIGGER USER`);
      const huella = await getHuellaPlan(db, x.clienteId, x.planId);
      await expect(decidirPlan({ db }, x.clienteId, x.planId, x.actores.cliente, { decision: 'aprobado', huellaVista: huella })).rejects.toThrow();
      expect((await getPlan(db, x.clienteId, x.planId))!.estado).toBe('propuesto');
      expect((await db.query('SELECT 1 FROM aprobaciones_plan WHERE plan_id = $1', [x.planId])).rows).toHaveLength(0);
    });
  });
});
