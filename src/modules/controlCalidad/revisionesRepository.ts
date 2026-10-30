import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';
import type { CheckQC, ResultadoQC } from './tipos.js';

// Reads of the quality-control reports. They are written only by ejecutarQC (and by the test factories).

export interface RevisionView {
  id: string;
  seq: string;
  cliente_id: ClienteId;
  pieza_id: string;
  produccion_id: string;
  produccion_version: number;
  hash_version: string;
  /** Lower-case hex. */
  hash_pieza: string;
  resultado: ResultadoQC;
  checks: CheckQC[];
  codigos_fallo: string[];
  duracion_ms: number;
  actor_tipo: 'usuario' | 'sistema';
  actor_usuario_id: string | null;
  creado_en: Date;
}

const COLUMNS = `r.id, r.seq::text AS seq, r.cliente_id, r.pieza_id, r.produccion_id, r.produccion_version, r.hash_version,
  encode(r.hash_pieza, 'hex') AS hash_pieza, r.resultado, r.checks, r.codigos_fallo, r.duracion_ms, r.actor_tipo,
  r.actor_usuario_id, r.creado_en`;

/**
 * The report that counts for a production: the LATEST one (by seq) of exactly that production. Null when
 * there is none, also for another client's production. The caller compares version and hash with the
 * production it cares about.
 */
export async function getUltimaRevision(db: Db, clienteId: ClienteId, produccionId: string): Promise<RevisionView | null> {
  const { rows } = await db.query<RevisionView>(
    `SELECT ${COLUMNS} FROM revisiones_calidad r WHERE r.cliente_id = $1 AND r.produccion_id = $2 ORDER BY r.seq DESC LIMIT 1`,
    [clienteId, produccionId],
  );
  return rows[0] ?? null;
}

/** The latest report of the piece's CURRENT production, or null. */
export async function getUltimaRevisionDePieza(db: Db, clienteId: ClienteId, piezaId: string): Promise<RevisionView | null> {
  const { rows } = await db.query<RevisionView>(
    `SELECT ${COLUMNS}
     FROM revisiones_calidad r
     JOIN producciones x ON x.id = r.produccion_id AND x.cliente_id = r.cliente_id
     WHERE r.cliente_id = $1 AND r.pieza_id = $2 AND x.es_actual
     ORDER BY r.seq DESC LIMIT 1`,
    [clienteId, piezaId],
  );
  return rows[0] ?? null;
}
