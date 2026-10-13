import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../config/index.js';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { UsuarioRow } from '../usuarios/usuariosRepository.js';

// Global table (no cliente_id), like usuarios. Users are read with plain SQL here instead of
// importing the usuarios repository, which itself calls revokeAllSessions.
// Nothing in this module logs or audits the token or its hash.

/** `ultimo_uso` is refreshed at most this often, so most requests cause no write. */
const TOUCH_SECONDS = 60;

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export interface CreatedSession {
  /** The plain token. Returned once; only its hash is stored. */
  token: string;
  sesionId: string;
  expiraEn: Date;
}

export async function createSession(db: Db, usuarioId: string): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; expira_en: Date }>(
      `INSERT INTO sesiones (usuario_id, token_hash, expira_en)
       VALUES ($1, $2, now() + make_interval(hours => $3))
       RETURNING id, expira_en`,
      [usuarioId, hashToken(token), config.SESSION_TTL_HOURS],
    );
    const row = rows[0]!;
    await recordAudit(tx, {
      actor: { tipo: 'usuario', usuarioId },
      accion: 'crear',
      tabla: 'sesiones',
      filaId: row.id,
      despues: { usuario_id: usuarioId, expira_en: row.expira_en },
    });
    return { token, sesionId: row.id, expiraEn: row.expira_en };
  });
}

/**
 * Returns the session's user, or null if the token is unknown, revoked, expired, idle for too
 * long, or its user is inactive. All time checks use the database clock.
 *
 * The idle check reads `ultimo_uso`, which is refreshed only when it is more than 60 seconds old,
 * so the effective idle timeout can be up to 60 seconds longer than SESSION_IDLE_MINUTES.
 */
export async function validateSession(db: Db, token: string): Promise<UsuarioRow | null> {
  if (!token) return null;
  const { rows } = await db.query<UsuarioRow & { sesion_id: string }>(
    `SELECT u.id, u.email, u.nombre, u.activo, u.creado_en, s.id AS sesion_id
     FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_hash = $1
       AND s.revocada_en IS NULL
       AND s.expira_en > now()
       AND s.ultimo_uso > now() - make_interval(mins => $2)
       AND u.activo`,
    [hashToken(token), config.SESSION_IDLE_MINUTES],
  );
  const found = rows[0];
  if (!found) return null;
  await db.query(
    `UPDATE sesiones SET ultimo_uso = now()
     WHERE id = $1 AND ultimo_uso < now() - make_interval(secs => $2)`,
    [found.sesion_id, TOUCH_SECONDS],
  );
  const { sesion_id: _sesionId, ...user } = found;
  return user;
}

/** Revokes one session. Returns false (and writes nothing) for an unknown or already revoked token. */
export async function revokeSession(db: Db, token: string): Promise<boolean> {
  if (!token) return false;
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; usuario_id: string }>(
      `UPDATE sesiones SET revocada_en = now()
       WHERE token_hash = $1 AND revocada_en IS NULL
       RETURNING id, usuario_id`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return false;
    await recordAudit(tx, {
      actor: { tipo: 'usuario', usuarioId: row.usuario_id },
      accion: 'revocar',
      tabla: 'sesiones',
      filaId: row.id,
      despues: { usuario_id: row.usuario_id },
    });
    return true;
  });
}

/**
 * Revokes every active session of a user. Returns how many were revoked; writes one summary
 * audit row only when that number is above zero.
 */
export async function revokeAllSessions(db: Db, usuarioId: string, actor: AuditActor): Promise<number> {
  return runInTransaction(db, async (tx) => {
    const { rowCount } = await tx.query(
      'UPDATE sesiones SET revocada_en = now() WHERE usuario_id = $1 AND revocada_en IS NULL',
      [usuarioId],
    );
    const cantidad = rowCount ?? 0;
    if (cantidad > 0) {
      await recordAudit(tx, {
        actor,
        accion: 'revocar_todas',
        tabla: 'sesiones',
        filaId: usuarioId,
        despues: { usuario_id: usuarioId, cantidad },
      });
    }
    return cantidad;
  });
}
