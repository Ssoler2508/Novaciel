import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';

export type ClienteEstado = 'en_onboarding' | 'activo' | 'en_pausa';

export interface ClienteRow {
  id: ClienteId;
  nombre_comercial: string;
  razon_social: string | null;
  estado: ClienteEstado;
  creado_en: Date;
}

function toRow(row: Record<string, unknown>): ClienteRow {
  return { ...(row as unknown as ClienteRow), id: asClienteId(row.id as string) };
}

export async function createCliente(
  db: Db,
  params: { nombreComercial: string; razonSocial?: string | null; estado?: ClienteEstado },
  actor: AuditActor,
): Promise<ClienteRow> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO clientes (nombre_comercial, razon_social, estado)
       VALUES ($1, $2, coalesce($3, 'en_onboarding')) RETURNING *`,
      [params.nombreComercial, params.razonSocial ?? null, params.estado ?? null],
    );
    const row = toRow(rows[0]);
    await recordAudit(tx, {
      actor,
      accion: 'crear',
      tabla: 'clientes',
      filaId: row.id,
      clienteId: row.id,
      despues: { ...row },
    });
    return row;
  });
}

export async function getClienteById(db: Db, id: ClienteId): Promise<ClienteRow | null> {
  const { rows } = await db.query('SELECT * FROM clientes WHERE id = $1', [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function updateClienteEstado(
  db: Db,
  id: ClienteId,
  estado: ClienteEstado,
  actor: AuditActor,
): Promise<ClienteRow | null> {
  return runInTransaction(db, async (tx) => {
    const before = (await tx.query('SELECT * FROM clientes WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) return null;
    const after = toRow((await tx.query('UPDATE clientes SET estado = $2 WHERE id = $1 RETURNING *', [id, estado])).rows[0]);
    await recordAudit(tx, {
      actor,
      accion: 'cambiar_estado',
      tabla: 'clientes',
      filaId: id,
      clienteId: id,
      antes: { ...toRow(before) },
      despues: { ...after },
    });
    return after;
  });
}

/** Names are not unique by design, so this returns the oldest match. Used by the seed to find its client again. */
export async function findClienteByNombreComercial(db: Db, nombreComercial: string): Promise<ClienteRow | null> {
  const { rows } = await db.query(
    'SELECT * FROM clientes WHERE nombre_comercial = $1 ORDER BY creado_en, id LIMIT 1',
    [nombreComercial],
  );
  return rows[0] ? toRow(rows[0]) : null;
}
