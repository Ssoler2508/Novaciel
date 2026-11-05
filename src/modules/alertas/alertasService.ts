import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit } from '../auditoria/recordAudit.js';
import { asClienteId } from '../shared/clienteId.js';
import { getAlerta, type AlertaScope, type AlertaView } from './alertasRepository.js';

export class AlertaNotFoundError extends Error {
  constructor() {
    super('Alert not found');
    this.name = 'AlertaNotFoundError';
  }
}

/**
 * Acknowledges an alert as a signed-in user. The alert is looked up THROUGH the scope, so an alert the caller
 * may not see is "not found" (never a different error that would confirm it exists). Acknowledging twice is
 * harmless: the first acknowledgement stays (who and when), no second row and no second audit row.
 * `alertas` itself is never updated: the acknowledgement is its own append-only record.
 */
export async function reconocerAlerta(
  db: Db,
  scope: AlertaScope,
  alertaId: string,
  usuarioId: string,
): Promise<{ alerta: AlertaView; nueva: boolean }> {
  return runInTransaction(db, async (tx) => {
    const alerta = await getAlerta(tx, scope, alertaId);
    if (!alerta) throw new AlertaNotFoundError();
    const { rows } = await tx.query<{ alerta_id: string }>(
      `INSERT INTO alertas_reconocimientos (alerta_id, cliente_id, usuario_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (alerta_id) DO NOTHING
       RETURNING alerta_id`,
      [alerta.id, alerta.clienteId, usuarioId],
    );
    const nueva = rows.length > 0;
    if (nueva) {
      await recordAudit(tx, {
        actor: { tipo: 'usuario', usuarioId },
        accion: 'reconocer',
        tabla: 'alertas_reconocimientos',
        filaId: alerta.id,
        clienteId: alerta.clienteId === null ? null : asClienteId(alerta.clienteId),
        despues: { codigo: alerta.codigo, severidad: alerta.severidad },
      });
    }
    return { alerta: (await getAlerta(tx, scope, alertaId))!, nueva };
  });
}
