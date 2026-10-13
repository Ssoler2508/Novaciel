import type { Db } from '../../../src/db/types.js';
import { hashPassword } from '../../../src/lib/crypto/passwords.js';
import { uniqueSuffix } from './unique.js';

export interface UsuarioRow {
  id: string;
  email: string;
  nombre: string;
  activo: boolean;
  creado_en: Date;
}

/** `password` (plain, ficticio) is hashed with the configured cost; without it the user cannot log in. */
export async function createUsuario(
  db: Db,
  overrides: Partial<Omit<UsuarioRow, 'id' | 'creado_en'>> & { password?: string } = {},
): Promise<UsuarioRow> {
  const suffix = uniqueSuffix();
  const row = {
    email: `usuario-${suffix}@example.test`,
    nombre: `Usuario Ficticio ${suffix}`,
    activo: true,
    ...overrides,
  };
  const passwordHash = overrides.password === undefined ? null : await hashPassword(overrides.password);
  const { rows } = await db.query<UsuarioRow>(
    `INSERT INTO usuarios (email, nombre, activo, password_hash) VALUES ($1, $2, $3, $4)
     RETURNING id, email, nombre, activo, creado_en`,
    [row.email, row.nombre, row.activo, passwordHash],
  );
  return rows[0]!;
}
