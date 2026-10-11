import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';
import { deleteClientRow, updateClientRow } from '../shared/clientRows.js';

export type ReglaTipo = 'promesa' | 'tema' | 'palabra' | 'elemento_visual';

export interface ReglaRow {
  id: string;
  cliente_id: ClienteId;
  tipo: ReglaTipo;
  texto: string;
  motivo: string | null;
  creado_en: Date;
}

export type ReglaPatch = Partial<{ tipo: ReglaTipo; texto: string; motivo: string | null }>;

const UPDATABLE = ['tipo', 'texto', 'motivo'] as const;

export async function createRegla(
  db: Db,
  clienteId: ClienteId,
  params: { tipo: ReglaTipo; texto: string; motivo?: string | null },
  actor: AuditActor,
): Promise<ReglaRow> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<ReglaRow>(
      `INSERT INTO reglas_prohibidas (cliente_id, tipo, texto, motivo) VALUES ($1, $2, $3, $4) RETURNING *`,
      [clienteId, params.tipo, params.texto, params.motivo ?? null],
    );
    const row = rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'crear',
      tabla: 'reglas_prohibidas',
      filaId: row.id,
      clienteId,
      despues: { ...row },
    });
    return row;
  });
}

export async function listReglas(db: Db, clienteId: ClienteId): Promise<ReglaRow[]> {
  const { rows } = await db.query<ReglaRow>(
    'SELECT * FROM reglas_prohibidas WHERE cliente_id = $1 ORDER BY tipo, texto',
    [clienteId],
  );
  return rows;
}

export function updateRegla(
  db: Db,
  clienteId: ClienteId,
  id: string,
  patch: ReglaPatch,
  actor: AuditActor,
): Promise<ReglaRow | null> {
  return updateClientRow<ReglaRow>(db, { tabla: 'reglas_prohibidas', allowed: UPDATABLE, clienteId, id, patch, actor });
}

export function deleteRegla(db: Db, clienteId: ClienteId, id: string, actor: AuditActor): Promise<boolean> {
  return deleteClientRow(db, { tabla: 'reglas_prohibidas', clienteId, id, actor });
}
