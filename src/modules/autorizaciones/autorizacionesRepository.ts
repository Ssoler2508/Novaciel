import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';
import { updateClientRow } from '../shared/clientRows.js';

// Consent records are never deleted, only revoked: this module deliberately exports no delete function.

export interface AutorizacionRow {
  id: string;
  cliente_id: ClienteId;
  persona_nombre: string;
  alcance: string;
  vigente_desde: Date;
  vigente_hasta: Date;
  revocada_en: Date | null;
  documento_clave: string;
  es_menor: boolean;
  creado_en: Date;
}

export interface NewAutorizacion {
  personaNombre: string;
  alcance: string;
  vigenteDesde?: Date;
  vigenteHasta: Date;
  /** Storage key of the signed document. */
  documentoClave: string;
  /** Required, no default: whoever records an authorization must state it. */
  esMenor: boolean;
}

/** Only these fields can change. New consent (another person, document or minor status) is a new row. */
export type AutorizacionPatch = Partial<{ alcance: string; vigente_desde: Date; vigente_hasta: Date }>;

const UPDATABLE = ['alcance', 'vigente_desde', 'vigente_hasta'] as const;

export async function createAutorizacion(
  db: Db,
  clienteId: ClienteId,
  params: NewAutorizacion,
  actor: AuditActor,
): Promise<AutorizacionRow> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<AutorizacionRow>(
      `INSERT INTO autorizaciones_imagen
         (cliente_id, persona_nombre, alcance, vigente_desde, vigente_hasta, documento_clave, es_menor)
       VALUES ($1, $2, $3, coalesce($4, now()), $5, $6, $7) RETURNING *`,
      [
        clienteId,
        params.personaNombre,
        params.alcance,
        params.vigenteDesde ?? null,
        params.vigenteHasta,
        params.documentoClave,
        params.esMenor,
      ],
    );
    const row = rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'crear',
      tabla: 'autorizaciones_imagen',
      filaId: row.id,
      clienteId,
      despues: { ...row },
    });
    return row;
  });
}

export async function getAutorizacion(db: Db, clienteId: ClienteId, id: string): Promise<AutorizacionRow | null> {
  const { rows } = await db.query<AutorizacionRow>(
    'SELECT * FROM autorizaciones_imagen WHERE id = $1 AND cliente_id = $2',
    [id, clienteId],
  );
  return rows[0] ?? null;
}

/** All authorizations of the client, including expired, revoked and minors'. Agents must use getValidAutorizaciones. */
export async function listAutorizaciones(db: Db, clienteId: ClienteId): Promise<AutorizacionRow[]> {
  const { rows } = await db.query<AutorizacionRow>(
    'SELECT * FROM autorizaciones_imagen WHERE cliente_id = $1 ORDER BY vigente_desde, id',
    [clienteId],
  );
  return rows;
}

export function updateAutorizacion(
  db: Db,
  clienteId: ClienteId,
  id: string,
  patch: AutorizacionPatch,
  actor: AuditActor,
): Promise<AutorizacionRow | null> {
  return updateClientRow<AutorizacionRow>(db, {
    tabla: 'autorizaciones_imagen',
    allowed: UPDATABLE,
    clienteId,
    id,
    patch,
    actor,
  });
}

/** Withdraws consent at `at` (default now). Returns null if the row is not the client's or is already revoked. */
export async function revokeAutorizacion(
  db: Db,
  clienteId: ClienteId,
  id: string,
  actor: AuditActor,
  at: Date = new Date(),
): Promise<AutorizacionRow | null> {
  return runInTransaction(db, async (tx) => {
    const before = (
      await tx.query<AutorizacionRow>(
        'SELECT * FROM autorizaciones_imagen WHERE id = $1 AND cliente_id = $2 AND revocada_en IS NULL FOR UPDATE',
        [id, clienteId],
      )
    ).rows[0];
    if (!before) return null;
    const after = (
      await tx.query<AutorizacionRow>(
        'UPDATE autorizaciones_imagen SET revocada_en = $3 WHERE id = $1 AND cliente_id = $2 RETURNING *',
        [id, clienteId, at],
      )
    ).rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'revocar',
      tabla: 'autorizaciones_imagen',
      filaId: id,
      clienteId,
      antes: { ...before },
      despues: { ...after },
    });
    return after;
  });
}

/**
 * Authorizations usable at `at` (default now). Always excludes minors, expired and revoked rows.
 * There is deliberately no flag to include minors; a later step may add one, explicitly.
 */
export async function getValidAutorizaciones(
  db: Db,
  clienteId: ClienteId,
  at: Date = new Date(),
): Promise<AutorizacionRow[]> {
  const { rows } = await db.query<AutorizacionRow>(
    `SELECT * FROM autorizaciones_imagen
     WHERE cliente_id = $1
       AND es_menor = false
       AND vigente_desde <= $2 AND vigente_hasta > $2
       AND (revocada_en IS NULL OR revocada_en > $2)
     ORDER BY vigente_desde, id`,
    [clienteId, at],
  );
  return rows;
}
