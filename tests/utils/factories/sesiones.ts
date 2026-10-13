import { randomBytes } from 'node:crypto';
import type { Db } from '../../../src/db/types.js';
import { hashToken } from '../../../src/modules/sesiones/sesionesRepository.js';
import { createUsuario } from './usuarios.js';

export interface SesionOverrides {
  usuarioId?: string;
  /** Seconds relative to now(); negative = in the past. */
  expiraEnSegundos?: number;
  ultimoUsoHaceSegundos?: number;
  revoked?: boolean;
}

/** Inserts a session with a known token (plain SQL, no audit). Returns the token and ids. */
export async function createSesion(db: Db, overrides: SesionOverrides = {}): Promise<{ id: string; usuarioId: string; token: string }> {
  const usuarioId = overrides.usuarioId ?? (await createUsuario(db)).id;
  const token = randomBytes(32).toString('base64url');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sesiones (usuario_id, token_hash, expira_en, ultimo_uso, revocada_en)
     VALUES ($1, $2, now() + make_interval(secs => $3), now() - make_interval(secs => $4), CASE WHEN $5::boolean THEN now() END)
     RETURNING id`,
    [usuarioId, hashToken(token), overrides.expiraEnSegundos ?? 3600, overrides.ultimoUsoHaceSegundos ?? 0, overrides.revoked ?? false],
  );
  return { id: rows[0]!.id, usuarioId, token };
}
