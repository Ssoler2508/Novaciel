import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';

// Reads of weekly plans. Every query filters by cliente_id. A plan's pieces are read with
// listPiezas({ planId }) from the piezas module.

export type PlanEstado = 'borrador' | 'propuesto' | 'aprobado' | 'descartado';

export interface PlanRow {
  id: string;
  cliente_id: ClienteId;
  /** The Monday of the week in the client's zone, YYYY-MM-DD. */
  semana_inicio: string;
  zona_horaria: string;
  estado: PlanEstado;
  perfil_marca_id: string;
  /** NULL when the system created it. */
  creado_por: string | null;
  creado_en: Date;
}

export const PLAN_COLUMNS = `id, cliente_id, semana_inicio::text AS semana_inicio, zona_horaria, estado, perfil_marca_id, creado_por, creado_en`;

export async function getPlan(db: Db, clienteId: ClienteId, id: string): Promise<PlanRow | null> {
  const { rows } = await db.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM planes_semanales WHERE id = $1 AND cliente_id = $2`, [id, clienteId]);
  return rows[0] ?? null;
}

/** The non-discarded plan of a week (the Monday, YYYY-MM-DD), or null. */
export async function getPlanActivoDeSemana(db: Db, clienteId: ClienteId, semanaInicio: string): Promise<PlanRow | null> {
  const { rows } = await db.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM planes_semanales WHERE cliente_id = $1 AND semana_inicio = $2::date AND estado <> 'descartado'`,
    [clienteId, semanaInicio],
  );
  return rows[0] ?? null;
}

/** Plans of the client, newest week first (discarded ones included: they are audit history). */
export async function listPlanes(db: Db, clienteId: ClienteId, filters: { semana?: string } = {}): Promise<PlanRow[]> {
  const params: unknown[] = [clienteId];
  let where = 'cliente_id = $1';
  if (filters.semana) {
    params.push(filters.semana);
    where += ` AND semana_inicio = $${params.length}::date`;
  }
  const { rows } = await db.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM planes_semanales WHERE ${where} ORDER BY semana_inicio DESC, creado_en DESC, id`,
    params,
  );
  return rows;
}
