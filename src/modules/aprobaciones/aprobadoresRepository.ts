import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';

// The main approver and the substitute of a client (spec 11.3). The table's trigger validates both
// users (active, an approval role for THAT client, no NovaCiel role). Every change is audited.

export interface AprobadoresRow {
  cliente_id: ClienteId;
  principal_usuario_id: string;
  suplente_usuario_id: string | null;
  actualizado_por: string | null;
  actualizado_en: Date;
}

export async function getAprobadores(db: Db, clienteId: ClienteId): Promise<AprobadoresRow | null> {
  const { rows } = await db.query<AprobadoresRow>(
    'SELECT cliente_id, principal_usuario_id, suplente_usuario_id, actualizado_por, actualizado_en FROM aprobadores_cliente WHERE cliente_id = $1',
    [clienteId],
  );
  return rows[0] ?? null;
}

/** Creates or replaces the approvers of a client, audited with ids only. A no-op when nothing changes. */
export async function setAprobadores(
  db: Db,
  clienteId: ClienteId,
  input: { principalUsuarioId: string; suplenteUsuarioId?: string | null },
  actor: AuditActor,
): Promise<{ row: AprobadoresRow; changed: boolean }> {
  return runInTransaction(db, async (tx) => {
    const antes = await getAprobadores(tx, clienteId);
    const suplente = input.suplenteUsuarioId ?? null;
    if (antes && antes.principal_usuario_id === input.principalUsuarioId && antes.suplente_usuario_id === suplente) {
      return { row: antes, changed: false };
    }
    const { rows } = await tx.query<AprobadoresRow>(
      `INSERT INTO aprobadores_cliente (cliente_id, principal_usuario_id, suplente_usuario_id, actualizado_por)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cliente_id) DO UPDATE
         SET principal_usuario_id = EXCLUDED.principal_usuario_id, suplente_usuario_id = EXCLUDED.suplente_usuario_id,
             actualizado_por = EXCLUDED.actualizado_por
       RETURNING cliente_id, principal_usuario_id, suplente_usuario_id, actualizado_por, actualizado_en`,
      [clienteId, input.principalUsuarioId, suplente, actor.tipo === 'usuario' ? actor.usuarioId : null],
    );
    await recordAudit(tx, {
      actor,
      accion: antes ? 'actualizar' : 'crear',
      tabla: 'aprobadores_cliente',
      filaId: clienteId,
      clienteId,
      antes: antes ? { principal_usuario_id: antes.principal_usuario_id, suplente_usuario_id: antes.suplente_usuario_id } : null,
      despues: { principal_usuario_id: input.principalUsuarioId, suplente_usuario_id: suplente },
    });
    return { row: rows[0]!, changed: true };
  });
}
