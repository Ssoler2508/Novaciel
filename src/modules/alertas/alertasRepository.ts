import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';

// Read side of the persistent alerts (Step 11). Every read takes an explicit scope:
//  - { tipo: 'cliente' }: what a CLIENT role may see. Only that client's alerts, and only the codes in
//    CODIGOS_VISIBLES_CLIENTE. It can never return a global alert (cliente_id NULL) or another client's.
//  - { tipo: 'novaciel' }: NovaCiel staff. Every alert, or only one client's when `clienteId` is given.
//    Global alerts appear only when no client is given.
// Alerts hold ids, codes and numbers only; nothing here is client text.

export const SEVERIDADES = ['info', 'aviso', 'critica'] as const;
export type Severidad = (typeof SEVERIDADES)[number];

/** The only alert code a client role sees (aprobacion_escalada is NovaCiel-only, as decided in Step 9). */
export const CODIGOS_VISIBLES_CLIENTE: readonly string[] = ['aprobacion_vencida'];

export type AlertaScope = { tipo: 'cliente'; clienteId: ClienteId } | { tipo: 'novaciel'; clienteId?: ClienteId };

export interface AlertaView {
  id: string;
  clienteId: string | null;
  codigo: string;
  severidad: Severidad;
  parametros: Record<string, unknown>;
  creadoEn: Date;
  reconocida: boolean;
  reconocidaPor: string | null;
  reconocidaEn: Date | null;
}

interface AlertaRow {
  id: string;
  cliente_id: string | null;
  codigo: string;
  severidad: Severidad;
  parametros: Record<string, unknown>;
  creado_en: Date;
  reconocida_por: string | null;
  reconocida_en: Date | null;
}

const COLUMNS = `a.id, a.cliente_id, a.codigo, a.severidad, a.parametros, a.creado_en,
  r.usuario_id AS reconocida_por, r.reconocido_en AS reconocida_en`;
const FROM = 'alertas a LEFT JOIN alertas_reconocimientos r ON r.alerta_id = a.id';

function toView(row: AlertaRow): AlertaView {
  return {
    id: row.id,
    clienteId: row.cliente_id,
    codigo: row.codigo,
    severidad: row.severidad,
    parametros: row.parametros,
    creadoEn: row.creado_en,
    reconocida: row.reconocida_en !== null,
    reconocidaPor: row.reconocida_por,
    reconocidaEn: row.reconocida_en,
  };
}

/** The WHERE conditions of a scope; `params` receives its values. */
function scopeWhere(scope: AlertaScope, params: unknown[]): string[] {
  if (scope.tipo === 'cliente') {
    params.push(scope.clienteId, [...CODIGOS_VISIBLES_CLIENTE]);
    return [`a.cliente_id = $${params.length - 1}`, `a.codigo = ANY($${params.length}::text[])`];
  }
  if (scope.clienteId) {
    params.push(scope.clienteId);
    return [`a.cliente_id = $${params.length}`];
  }
  return [];
}

export async function getAlerta(db: Db, scope: AlertaScope, alertaId: string): Promise<AlertaView | null> {
  const params: unknown[] = [alertaId];
  const where = ['a.id = $1', ...scopeWhere(scope, params)];
  const { rows } = await db.query<AlertaRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')}`, params);
  return rows[0] ? toView(rows[0]) : null;
}

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;

/** Newest first, stable order (creado_en DESC, id DESC). `limit` is clamped to 1..MAX_LIMIT. */
export async function listAlertas(db: Db, scope: AlertaScope, options: { limit?: number } = {}): Promise<AlertaView[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const params: unknown[] = [];
  const where = scopeWhere(scope, params);
  params.push(limit);
  const { rows } = await db.query<AlertaRow>(
    `SELECT ${COLUMNS} FROM ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.creado_en DESC, a.id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toView);
}
