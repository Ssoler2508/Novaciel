import type { Db } from '../../src/db/types.js';
import { decidirPlan, getHuellaPlan, proponerPlan, type AprobadorActor } from '../../src/modules/aprobaciones/index.js';
import type { ClienteId } from '../../src/modules/shared/clienteId.js';
import { createUsuarioConRol } from './factories/index.js';

/**
 * Test setup: NovaCiel proposes the plan and a fictional client approver approves it, through the real
 * services (Step 9). It replaced the former internal plan approval (removed).
 */
export async function aprobarPlanComoCliente(db: Db, clienteId: ClienteId, planId: string) {
  const staff = await createUsuarioConRol(db, 'operador_novaciel');
  const approver = await createUsuarioConRol(db, 'aprobador_cliente', clienteId);
  const novaciel: AprobadorActor = { usuarioId: staff.id, roles: [{ rol: 'operador_novaciel', clienteId: null }] };
  const cliente: AprobadorActor = { usuarioId: approver.id, roles: [{ rol: 'aprobador_cliente', clienteId }] };
  await proponerPlan({ db }, clienteId, planId, novaciel);
  return decidirPlan({ db }, clienteId, planId, cliente, { decision: 'aprobado', huellaVista: await getHuellaPlan(db, clienteId, planId) });
}
