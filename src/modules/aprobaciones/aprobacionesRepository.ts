import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';
import type { ProduccionActual, RegistroAprobacion } from './types.js';

// Reads for the approval services. Every query filters by cliente_id.

/** The decisions of a piece, oldest first (by seq), in the shape the pure rules read. */
export async function listRegistros(db: Db, clienteId: ClienteId, piezaId: string): Promise<RegistroAprobacion[]> {
  const { rows } = await db.query<{
    seq: string;
    produccion_id: string;
    version: number;
    hash_version: string;
    hash_pieza: Buffer;
    nivel: 'interno' | 'cliente';
    decision: 'aprobada' | 'cambios' | 'rechazada';
  }>(
    `SELECT seq::text AS seq, produccion_id, version, hash_version, hash_pieza, nivel, decision
     FROM aprobaciones WHERE cliente_id = $1 AND pieza_id = $2 ORDER BY seq`,
    [clienteId, piezaId],
  );
  return rows.map((r) => ({
    seq: r.seq,
    produccionId: r.produccion_id,
    version: r.version,
    hashVersion: r.hash_version,
    hashPieza: r.hash_pieza,
    nivel: r.nivel,
    decision: r.decision,
  }));
}

/** The current production of a piece, as the rules read it, or null. */
export async function getProduccionActualBasica(db: Db, clienteId: ClienteId, piezaId: string): Promise<ProduccionActual | null> {
  const { rows } = await db.query<{ id: string; version: number; hash_version: string; hash_pieza: Buffer }>(
    'SELECT id, version, hash_version, hash_pieza FROM producciones WHERE cliente_id = $1 AND pieza_id = $2 AND es_actual',
    [clienteId, piezaId],
  );
  const row = rows[0];
  return row ? { id: row.id, version: row.version, hashVersion: row.hash_version, hashPieza: row.hash_pieza } : null;
}

/** The fingerprint of a plan as the database defines it (plan_huella), lower-case hex. */
export async function getHuellaPlan(db: Db, clienteId: ClienteId, planId: string): Promise<string> {
  const { rows } = await db.query<{ h: string }>("SELECT encode(plan_huella($1, $2), 'hex') AS h", [planId, clienteId]);
  return rows[0]!.h;
}

// ---- What the routes show ----------------------------------------------------------------------

export interface RegistroVisible {
  seq: string;
  nivel: 'interno' | 'cliente';
  decision: 'aprobada' | 'cambios' | 'rechazada';
  motivo: string | null;
  segundo_ms: number | null;
  version: number;
  creado_en: Date;
  /** The user who decided; used to mark "propia" and never returned. */
  usuario_id: string;
  comentario: string | null;
}

/** Every decision of a piece, oldest first, WITH the comments. The caller decides who may read which comment. */
export async function listHistorialAprobaciones(db: Db, clienteId: ClienteId, piezaId: string): Promise<RegistroVisible[]> {
  const { rows } = await db.query<RegistroVisible>(
    `SELECT seq::text AS seq, nivel, decision, motivo, segundo_ms, version, creado_en, usuario_id, comentario
     FROM aprobaciones WHERE cliente_id = $1 AND pieza_id = $2 ORDER BY seq`,
    [clienteId, piezaId],
  );
  return rows;
}

export interface PiezaPendiente {
  id: string;
  red: string;
  formato: string;
  estado: string;
  fecha_hora: Date;
  version: number;
  hash_pieza: string;
}

/** Pieces with a current production that wait for a level: NovaCiel's review or the client's decision. */
export async function listPiezasPendientes(db: Db, clienteId: ClienteId, nivel: 'interno' | 'cliente'): Promise<PiezaPendiente[]> {
  const estados = nivel === 'interno' ? ['en_control_calidad', 'revision_novaciel'] : ['esperando_aprobacion'];
  const { rows } = await db.query<PiezaPendiente>(
    `SELECT p.id, p.red, p.formato, p.estado, p.fecha_hora, pr.version, encode(pr.hash_pieza, 'hex') AS hash_pieza
     FROM piezas p
     JOIN planes_semanales pl ON pl.id = p.plan_id AND pl.cliente_id = p.cliente_id
     JOIN producciones pr ON pr.pieza_id = p.id AND pr.cliente_id = p.cliente_id AND pr.es_actual
     WHERE p.cliente_id = $1 AND pl.estado = 'aprobado' AND p.estado = ANY($2::estado_pieza[])
     ORDER BY p.fecha_hora, p.id`,
    [clienteId, estados],
  );
  return rows;
}

export interface PlanPendiente {
  id: string;
  semana_inicio: string;
  piezas: number;
  primer_plazo: Date;
  huella_plan: string;
}

/** Plans proposed to the client and not decided yet. */
export async function listPlanesPendientes(db: Db, clienteId: ClienteId): Promise<PlanPendiente[]> {
  const { rows } = await db.query<PlanPendiente & { piezas: string }>(
    `SELECT pl.id, pl.semana_inicio::text AS semana_inicio, count(p.id)::text AS piezas, min(p.fecha_hora) AS primer_plazo,
            encode(plan_huella(pl.id, pl.cliente_id), 'hex') AS huella_plan
     FROM planes_semanales pl JOIN piezas p ON p.plan_id = pl.id AND p.cliente_id = pl.cliente_id
     WHERE pl.cliente_id = $1 AND pl.estado = 'propuesto'
     GROUP BY pl.id, pl.cliente_id, pl.semana_inicio
     ORDER BY pl.semana_inicio, pl.id`,
    [clienteId],
  );
  return rows.map((r) => ({ ...r, piezas: Number(r.piezas) }));
}
