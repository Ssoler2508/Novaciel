import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from './clienteId.js';
import { buildUpdate } from './updateBuilder.js';

/**
 * Update of one client-table row with audit. Every statement filters by cliente_id.
 * Returns null (and writes no audit row) when no row of that client matches or the patch is empty.
 */
export async function updateClientRow<Row>(
  db: Db,
  params: {
    tabla: string;
    allowed: readonly string[];
    clienteId: ClienteId;
    id: string;
    patch: Record<string, unknown>;
    actor: AuditActor;
    accion?: string;
  },
): Promise<Row | null> {
  // Validates the patch (whitelist, no id/cliente_id) before touching the database.
  const built = buildUpdate(params.tabla, params.allowed, params.patch, params.id, params.clienteId);
  if (!built) return null;
  return runInTransaction(db, async (tx) => {
    const before = (
      await tx.query(`SELECT * FROM ${params.tabla} WHERE id = $1 AND cliente_id = $2 FOR UPDATE`, [
        params.id,
        params.clienteId,
      ])
    ).rows[0];
    if (!before) return null;
    const after = (await tx.query(built.sql, built.values)).rows[0];
    await recordAudit(tx, {
      actor: params.actor,
      accion: params.accion ?? 'actualizar',
      tabla: params.tabla,
      filaId: params.id,
      clienteId: params.clienteId,
      antes: { ...before },
      despues: { ...after },
    });
    return after as Row;
  });
}

/** Hard delete of one client-table row with audit. Filtered by cliente_id; false when nothing matched. */
export async function deleteClientRow(
  db: Db,
  params: { tabla: string; clienteId: ClienteId; id: string; actor: AuditActor },
): Promise<boolean> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query(`DELETE FROM ${params.tabla} WHERE id = $1 AND cliente_id = $2 RETURNING *`, [
      params.id,
      params.clienteId,
    ]);
    const before = rows[0];
    if (!before) return false;
    await recordAudit(tx, {
      actor: params.actor,
      accion: 'eliminar',
      tabla: params.tabla,
      filaId: params.id,
      clienteId: params.clienteId,
      antes: { ...before },
    });
    return true;
  });
}
