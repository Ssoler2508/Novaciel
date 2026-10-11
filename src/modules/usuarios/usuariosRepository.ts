import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';

/** Global table: users are not tied to one client, so these functions take no cliente_id. */
export interface UsuarioRow {
  id: string;
  email: string;
  nombre: string;
  activo: boolean;
  creado_en: Date;
}

export async function createUsuario(
  db: Db,
  params: { email: string; nombre: string; activo?: boolean },
  actor: AuditActor,
): Promise<UsuarioRow> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<UsuarioRow>(
      `INSERT INTO usuarios (email, nombre, activo) VALUES ($1, $2, coalesce($3, true)) RETURNING *`,
      [params.email, params.nombre, params.activo ?? null],
    );
    const row = rows[0]!;
    await recordAudit(tx, { actor, accion: 'crear', tabla: 'usuarios', filaId: row.id, despues: { ...row } });
    return row;
  });
}

export async function getUsuarioById(db: Db, id: string): Promise<UsuarioRow | null> {
  const { rows } = await db.query<UsuarioRow>('SELECT * FROM usuarios WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Emails are unique case-insensitively, so the lookup uses lower(email). */
export async function getUsuarioByEmail(db: Db, email: string): Promise<UsuarioRow | null> {
  const { rows } = await db.query<UsuarioRow>('SELECT * FROM usuarios WHERE lower(email) = lower($1)', [email]);
  return rows[0] ?? null;
}

export async function setUsuarioActivo(
  db: Db,
  id: string,
  activo: boolean,
  actor: AuditActor,
): Promise<UsuarioRow | null> {
  return runInTransaction(db, async (tx) => {
    const before = (await tx.query<UsuarioRow>('SELECT * FROM usuarios WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) return null;
    const after = (await tx.query<UsuarioRow>('UPDATE usuarios SET activo = $2 WHERE id = $1 RETURNING *', [id, activo]))
      .rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'cambiar_activo',
      tabla: 'usuarios',
      filaId: id,
      antes: { ...before },
      despues: { ...after },
    });
    return after;
  });
}
