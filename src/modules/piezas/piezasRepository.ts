import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';
import type { EstadoPieza } from './estados.js';

// Reads of pieces and their state history. Every query filters by cliente_id.

export interface PiezaRow {
  id: string;
  cliente_id: ClienteId;
  plan_id: string;
  red: 'instagram' | 'facebook' | 'tiktok' | 'youtube';
  formato: 'reel' | 'carrusel' | 'post' | 'historia';
  pilar: string;
  trabajo: 'atraer' | 'confianza' | 'accion';
  idea: string;
  fecha_hora: Date;
  estado: EstadoPieza;
  /** Set only while paused: the only state the piece may return to. */
  estado_previo: EstadoPieza | null;
  version_estado: number;
  creado_en: Date;
  actualizado_en: Date;
  /** Ids of the verified facts the piece cites. */
  hecho_ids: string[];
  /** State of the piece's plan. Pieces of a 'descartado' plan are dead: they cannot change state. */
  plan_estado: 'borrador' | 'propuesto' | 'aprobado' | 'descartado';
}

export interface HistorialRow {
  id: string;
  cliente_id: ClienteId;
  pieza_id: string;
  version: number;
  /** NULL only for the creation row. */
  desde: EstadoPieza | null;
  hacia: EstadoPieza;
  actor_tipo: 'usuario' | 'sistema';
  actor_usuario_id: string | null;
  motivo: string | null;
  creado_en: Date;
}

export const PIEZA_COLUMNS = `p.id, p.cliente_id, p.plan_id, p.red, p.formato, p.pilar, p.trabajo, p.idea, p.fecha_hora,
  p.estado, p.estado_previo, p.version_estado, p.creado_en, p.actualizado_en,
  ARRAY(SELECT h.hecho_id FROM piezas_hechos h WHERE h.pieza_id = p.id AND h.cliente_id = p.cliente_id ORDER BY h.hecho_id) AS hecho_ids,
  pl.estado AS plan_estado`;

/** The piece joined with its plan (same client on both sides). */
export const PIEZA_FROM = `FROM piezas p JOIN planes_semanales pl ON pl.id = p.plan_id AND pl.cliente_id = p.cliente_id`;

export interface PiezaReadOptions {
  /** For audit views: also return pieces whose plan was discarded. They are hidden by default. */
  includeDescartados?: boolean;
}

/** A piece of the client; null for another client's piece, and for a piece of a discarded plan unless asked. */
export async function getPieza(db: Db, clienteId: ClienteId, id: string, options: PiezaReadOptions = {}): Promise<PiezaRow | null> {
  const { rows } = await db.query<PiezaRow>(
    `SELECT ${PIEZA_COLUMNS} ${PIEZA_FROM} WHERE p.id = $1 AND p.cliente_id = $2 AND ($3::boolean OR pl.estado <> 'descartado')`,
    [id, clienteId, options.includeDescartados ?? false],
  );
  return rows[0] ?? null;
}

export interface ListPiezasFilters extends PiezaReadOptions {
  planId?: string;
  /** One state or several. */
  estado?: EstadoPieza | readonly EstadoPieza[];
  /** `fecha_hora >= desde`. */
  desde?: Date;
  /** `fecha_hora < hasta`. */
  hasta?: Date;
}

/** Pieces of the client, ordered by scheduled time (then id). */
export async function listPiezas(db: Db, clienteId: ClienteId, filters: ListPiezasFilters = {}): Promise<PiezaRow[]> {
  const params: unknown[] = [clienteId];
  const where = ['p.cliente_id = $1'];
  // Pieces of a discarded plan are dead: hidden unless an audit view asks for them.
  if (!filters.includeDescartados) where.push(`pl.estado <> 'descartado'`);
  if (filters.planId) {
    params.push(filters.planId);
    where.push(`p.plan_id = $${params.length}`);
  }
  if (filters.estado !== undefined) {
    params.push(typeof filters.estado === 'string' ? [filters.estado] : [...filters.estado]);
    where.push(`p.estado = ANY($${params.length}::text[]::estado_pieza[])`);
  }
  if (filters.desde) {
    params.push(filters.desde);
    where.push(`p.fecha_hora >= $${params.length}`);
  }
  if (filters.hasta) {
    params.push(filters.hasta);
    where.push(`p.fecha_hora < $${params.length}`);
  }
  const { rows } = await db.query<PiezaRow>(
    `SELECT ${PIEZA_COLUMNS} ${PIEZA_FROM} WHERE ${where.join(' AND ')} ORDER BY p.fecha_hora, p.id`,
    params,
  );
  return rows;
}

/** The piece's state history, oldest first (version 0 is the creation row). Empty for another client's piece. */
export async function getHistorial(db: Db, clienteId: ClienteId, piezaId: string): Promise<HistorialRow[]> {
  const { rows } = await db.query<HistorialRow & { id: string }>(
    `SELECT id::text AS id, cliente_id, pieza_id, version, desde, hacia, actor_tipo, actor_usuario_id, motivo, creado_en
     FROM historial_estados_pieza WHERE pieza_id = $1 AND cliente_id = $2 ORDER BY version`,
    [piezaId, clienteId],
  );
  return rows;
}
