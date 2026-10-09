import type { Db } from '../../../src/db/types.js';
import { uniqueSuffix } from './unique.js';

export interface UsuarioRow {
  id: string;
  email: string;
  nombre: string;
  activo: boolean;
  creado_en: Date;
}

export async function createUsuario(db: Db, overrides: Partial<Omit<UsuarioRow, 'id' | 'creado_en'>> = {}): Promise<UsuarioRow> {
  const suffix = uniqueSuffix();
  const row = {
    email: `usuario-${suffix}@example.test`,
    nombre: `Usuario Ficticio ${suffix}`,
    activo: true,
    ...overrides,
  };
  const { rows } = await db.query<UsuarioRow>(
    `INSERT INTO usuarios (email, nombre, activo) VALUES ($1, $2, $3) RETURNING *`,
    [row.email, row.nombre, row.activo],
  );
  return rows[0]!;
}
