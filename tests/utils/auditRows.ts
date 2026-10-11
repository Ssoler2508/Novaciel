import type { Db } from '../../src/db/types.js';

export interface AuditRowForTest {
  actor_tipo: string;
  actor_usuario_id: string | null;
  accion: string;
  tabla: string;
  fila_id: string;
  cliente_id: string | null;
  datos_antes: Record<string, unknown> | null;
  datos_despues: Record<string, unknown> | null;
}

/** Audit rows for one row of one table, oldest first. */
export async function auditRowsFor(db: Db, tabla: string, filaId: string): Promise<AuditRowForTest[]> {
  const { rows } = await db.query<AuditRowForTest>(
    'SELECT * FROM auditoria WHERE tabla = $1 AND fila_id = $2 ORDER BY id',
    [tabla, filaId],
  );
  return rows;
}

export async function countAuditRows(db: Db): Promise<number> {
  return Number((await db.query('SELECT count(*) AS n FROM auditoria')).rows[0].n);
}
