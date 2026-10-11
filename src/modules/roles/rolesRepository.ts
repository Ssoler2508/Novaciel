import type { Db } from '../../db/types.js';

/** Global catalog (no cliente_id). Roles are always looked up by codigo, never by nombre or id. */
export interface RolRow {
  id: number;
  codigo: string;
  nombre: string;
  ambito: 'novaciel' | 'cliente';
}

export async function listRoles(db: Db): Promise<RolRow[]> {
  const { rows } = await db.query<RolRow>('SELECT id, codigo, nombre, ambito FROM roles ORDER BY id');
  return rows;
}

export async function getRoleByCodigo(db: Db, codigo: string): Promise<RolRow | null> {
  const { rows } = await db.query<RolRow>('SELECT id, codigo, nombre, ambito FROM roles WHERE codigo = $1', [codigo]);
  return rows[0] ?? null;
}
