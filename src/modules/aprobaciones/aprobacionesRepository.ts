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
