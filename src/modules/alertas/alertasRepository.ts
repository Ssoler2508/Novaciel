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

//  - { tipo: 'global' }: NovaCiel staff, only the alerts that belong to no client (cliente_id NULL).
export type AlertaScope = { tipo: 'cliente'; clienteId: ClienteId } | { tipo: 'novaciel'; clienteId?: ClienteId } | { tipo: 'global' };

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
  if (scope.tipo === 'global') return ['a.cliente_id IS NULL'];
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

export interface AlertaFiltros {
  codigo?: string;
  severidad?: Severidad;
  reconocida?: boolean;
}

export class CursorInvalidoError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'CursorInvalidoError';
  }
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const encodeCursor = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { ts: string; id: string } {
  const match = CURSOR_RE.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match) throw new CursorInvalidoError();
  return { ts: match[1]!, id: match[2]! };
}

/**
 * One page of alerts for a scope, newest first (creado_en DESC, id DESC: a total order), with the filters and an
 * opaque keyset cursor (`antes` = the `next` of the previous page). The cursor keeps the microseconds of
 * creado_en, so no alert is skipped or repeated. `limit` is clamped to 1..MAX_LIMIT.
 */
export async function pageAlertas(
  db: Db,
  scope: AlertaScope,
  options: AlertaFiltros & { limit?: number; antes?: string } = {},
): Promise<{ items: AlertaView[]; next: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const params: unknown[] = [];
  const where = scopeWhere(scope, params);
  if (options.codigo !== undefined) {
    params.push(options.codigo);
    where.push(`a.codigo = $${params.length}`);
  }
  if (options.severidad !== undefined) {
    params.push(options.severidad);
    where.push(`a.severidad = $${params.length}`);
  }
  if (options.reconocida !== undefined) where.push(options.reconocida ? 'r.alerta_id IS NOT NULL' : 'r.alerta_id IS NULL');
  if (options.antes !== undefined) {
    const { ts, id } = decodeCursor(options.antes);
    params.push(ts, id);
    where.push(`(a.creado_en, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const { rows } = await db.query<AlertaRow & { cursor_ts: string }>(
    `SELECT ${COLUMNS}, to_char(a.creado_en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
     FROM ${FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.creado_en DESC, a.id DESC LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(toView), next: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null };
}
