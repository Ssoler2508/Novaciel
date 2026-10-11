import type { Db } from '../../db/types.js';

export interface AuditEntry {
  actor: { tipo: 'sistema' } | { tipo: 'usuario'; usuarioId: string };
  accion: string;
  tabla: string;
  filaId: string;
  /** NULL for global events (for example a NovaCiel role assignment). */
  clienteId?: string | null;
  antes?: Record<string, unknown> | null;
  despues?: Record<string, unknown> | null;
}

/**
 * Appends one audit row. Only INSERTs and never opens its own transaction: it runs in the
 * caller's, so the audit row commits or rolls back together with the write it describes.
 */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO auditoria (actor_tipo, actor_usuario_id, accion, tabla, fila_id, cliente_id, datos_antes, datos_despues)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.actor.tipo,
      entry.actor.tipo === 'usuario' ? entry.actor.usuarioId : null,
      entry.accion,
      entry.tabla,
      entry.filaId,
      entry.clienteId ?? null,
      entry.antes ? JSON.stringify(entry.antes) : null,
      entry.despues ? JSON.stringify(entry.despues) : null,
    ],
  );
}
