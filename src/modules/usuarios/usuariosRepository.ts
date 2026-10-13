import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { assertPasswordPolicy, hashPassword, needsRehash, verifyPassword } from '../../lib/crypto/passwords.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { revokeAllSessions } from '../sesiones/sesionesRepository.js';

/**
 * Global table: users are not tied to one client, so these functions take no cliente_id.
 * Never SELECT * or RETURNING * here: the row also holds password_hash, which must not reach
 * callers or auditoria. Use USUARIO_COLUMNS.
 */
export interface UsuarioRow {
  id: string;
  email: string;
  nombre: string;
  activo: boolean;
  creado_en: Date;
}

const USUARIO_COLUMNS = 'id, email, nombre, activo, creado_en';

// Lockout policy (spec 16 defines none).
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export async function createUsuario(
  db: Db,
  params: { email: string; nombre: string; activo?: boolean },
  actor: AuditActor,
): Promise<UsuarioRow> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<UsuarioRow>(
      `INSERT INTO usuarios (email, nombre, activo) VALUES ($1, $2, coalesce($3, true)) RETURNING ${USUARIO_COLUMNS}`,
      [params.email, params.nombre, params.activo ?? null],
    );
    const row = rows[0]!;
    await recordAudit(tx, { actor, accion: 'crear', tabla: 'usuarios', filaId: row.id, despues: { ...row } });
    return row;
  });
}

export async function getUsuarioById(db: Db, id: string): Promise<UsuarioRow | null> {
  const { rows } = await db.query<UsuarioRow>(`SELECT ${USUARIO_COLUMNS} FROM usuarios WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Emails are unique case-insensitively, so the lookup uses lower(email). */
export async function getUsuarioByEmail(db: Db, email: string): Promise<UsuarioRow | null> {
  const { rows } = await db.query<UsuarioRow>(`SELECT ${USUARIO_COLUMNS} FROM usuarios WHERE lower(email) = lower($1)`, [email]);
  return rows[0] ?? null;
}

export async function setUsuarioActivo(
  db: Db,
  id: string,
  activo: boolean,
  actor: AuditActor,
): Promise<UsuarioRow | null> {
  return runInTransaction(db, async (tx) => {
    const before = (await tx.query<UsuarioRow>(`SELECT ${USUARIO_COLUMNS} FROM usuarios WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before) return null;
    const after = (await tx.query<UsuarioRow>(`UPDATE usuarios SET activo = $2 WHERE id = $1 RETURNING ${USUARIO_COLUMNS}`, [id, activo]))
      .rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'cambiar_activo',
      tabla: 'usuarios',
      filaId: id,
      antes: { ...before },
      despues: { ...after },
    });
    // Deactivating ends every session, so reactivating the user never revives an old one.
    if (!activo) await revokeAllSessions(tx, id, actor);
    return after;
  });
}

/**
 * Sets a new password and clears any lockout. Audited without the hash: it records only
 * `password_changed`. Returns null when the user does not exist.
 */
export async function setPassword(db: Db, usuarioId: string, plain: string, actor: AuditActor): Promise<UsuarioRow | null> {
  assertPasswordPolicy(plain);
  const hash = await hashPassword(plain);
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<UsuarioRow>(
      `UPDATE usuarios SET password_hash = $2, intentos_fallidos = 0, bloqueado_hasta = NULL
       WHERE id = $1 RETURNING ${USUARIO_COLUMNS}`,
      [usuarioId, hash],
    );
    const row = rows[0];
    if (!row) return null;
    await recordAudit(tx, {
      actor,
      accion: 'cambiar_password',
      tabla: 'usuarios',
      filaId: usuarioId,
      despues: { password_changed: true },
    });
    // A new password ends every existing session of the user.
    await revokeAllSessions(tx, usuarioId, actor);
    return row;
  });
}

// Compared against when the email is unknown (or the account cannot log in), so the response time
// does not reveal which emails exist. Built lazily with the configured cost.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing-only');
  return dummyHash;
}

interface LoginRow extends UsuarioRow {
  password_hash: string | null;
  bloqueado: boolean;
}

/**
 * Returns the user, or null for every kind of failure (unknown email, wrong password, no
 * password, inactive, locked): callers must not be able to tell them apart.
 *
 * Trade-off (accepted for an internal panel): anyone who knows an email can keep that account
 * locked by retrying every 15 minutes. Per-IP rate limiting is future work.
 */
export async function verifyCredentials(db: Db, email: string, plain: string): Promise<UsuarioRow | null> {
  const found = (
    await db.query<LoginRow>(
      `SELECT ${USUARIO_COLUMNS}, password_hash, (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > now()) AS bloqueado
       FROM usuarios WHERE lower(email) = lower($1)`,
      [email],
    )
  ).rows[0];
  // Always one hash comparison, whatever the reason for failing.
  const passwordOk = await verifyPassword(plain, found?.password_hash ?? (await getDummyHash()));
  if (!found || !found.password_hash || !found.activo || found.bloqueado) return null;

  if (passwordOk) {
    // Upgrade to the current cost in the same statement; the guard skips it if the password changed meanwhile.
    const newHash = needsRehash(found.password_hash) ? await hashPassword(plain) : null;
    const { rows } = await db.query<UsuarioRow>(
      `UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_login = now(),
         password_hash = CASE WHEN $2::text IS NOT NULL AND password_hash = $3 THEN $2 ELSE password_hash END
       WHERE id = $1 RETURNING ${USUARIO_COLUMNS}`,
      [found.id, newHash, found.password_hash],
    );
    return rows[0] ?? null;
  }

  await recordFailedAttempt(db, found.id);
  return null;
}

/**
 * One atomic statement, so concurrent failures never lose an increment:
 * - an expired lock restarts the count at 1 and clears bloqueado_hasta;
 * - otherwise the counter goes up and the 5th failure sets the lock;
 * - while a lock is active nothing changes (the WHERE is re-checked under the row lock).
 * Counter updates are not audited; only the lockout is.
 */
async function recordFailedAttempt(db: Db, usuarioId: string): Promise<void> {
  await runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ intentos_fallidos: number; bloqueado_hasta: Date | null }>(
      `UPDATE usuarios SET
         intentos_fallidos = CASE WHEN bloqueado_hasta IS NOT NULL THEN 1 ELSE intentos_fallidos + 1 END,
         bloqueado_hasta = CASE
           WHEN bloqueado_hasta IS NOT NULL THEN NULL
           WHEN intentos_fallidos + 1 >= $2 THEN now() + make_interval(mins => $3)
           ELSE NULL
         END
       WHERE id = $1 AND (bloqueado_hasta IS NULL OR bloqueado_hasta <= now())
       RETURNING intentos_fallidos, bloqueado_hasta`,
      [usuarioId, MAX_FAILED_ATTEMPTS, LOCK_MINUTES],
    );
    const row = rows[0];
    // The WHERE guarantees the lock was inactive before, so a lock now means this statement set it.
    if (row?.bloqueado_hasta) {
      await recordAudit(tx, {
        actor: { tipo: 'sistema' },
        accion: 'bloquear_cuenta',
        tabla: 'usuarios',
        filaId: usuarioId,
        despues: { intentos_fallidos: row.intentos_fallidos, bloqueado_hasta: row.bloqueado_hasta },
      });
    }
  });
}
