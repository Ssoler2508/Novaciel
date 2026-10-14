import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';
import { assertMicro, microToUsd, usdToMicro, type MicroUsd } from './money.js';

// Per-client spending settings (kill switch and default monthly ceiling). A missing row means
// spending enabled and no default ceiling. Like the other client repositories this does not check
// permissions: the routes of Step 11 will require `manage_budget`.

export interface SpendConfig {
  clienteId: ClienteId;
  gastoHabilitado: boolean;
  /** Null when the client has no default ceiling. */
  techoMensualDefecto: MicroUsd | null;
}

interface SpendConfigRow {
  cliente_id: ClienteId;
  gasto_habilitado: boolean;
  techo: string | null;
}

const SELECT = `SELECT cliente_id, gasto_habilitado, techo_mensual_defecto::text AS techo FROM configuracion_gasto_cliente`;

function toConfig(row: SpendConfigRow): SpendConfig {
  return {
    clienteId: row.cliente_id,
    gastoHabilitado: row.gasto_habilitado,
    techoMensualDefecto: row.techo === null ? null : usdToMicro(row.techo),
  };
}

export async function getSpendConfig(db: Db, clienteId: ClienteId): Promise<SpendConfig | null> {
  const { rows } = await db.query<SpendConfigRow>(`${SELECT} WHERE cliente_id = $1`, [clienteId]);
  return rows[0] ? toConfig(rows[0]) : null;
}

/**
 * Creates the settings row of a client. Insert-only: if the client already has one it is left
 * untouched (so hand edits survive) and null is returned. Audited in the same transaction.
 */
export async function createSpendConfig(
  db: Db,
  clienteId: ClienteId,
  input: { gastoHabilitado?: boolean; techoMensualDefecto: MicroUsd | null },
  actor: AuditActor,
): Promise<SpendConfig | null> {
  if (input.techoMensualDefecto !== null) assertMicro(input.techoMensualDefecto, 'techoMensualDefecto');
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<SpendConfigRow>(
      `INSERT INTO configuracion_gasto_cliente (cliente_id, gasto_habilitado, techo_mensual_defecto, actualizado_por)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cliente_id) DO NOTHING
       RETURNING cliente_id, gasto_habilitado, techo_mensual_defecto::text AS techo`,
      [
        clienteId,
        input.gastoHabilitado ?? true,
        input.techoMensualDefecto === null ? null : microToUsd(input.techoMensualDefecto),
        actor.tipo === 'usuario' ? actor.usuarioId : null,
      ],
    );
    const row = rows[0];
    if (!row) return null;
    await recordAudit(tx, {
      actor,
      accion: 'crear',
      tabla: 'configuracion_gasto_cliente',
      filaId: clienteId,
      clienteId,
      despues: { gasto_habilitado: row.gasto_habilitado, techo_mensual_defecto: row.techo },
    });
    return toConfig(row);
  });
}
