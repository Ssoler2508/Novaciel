import type { Db } from '../../../src/db/types.js';

export interface UsuarioRolRow {
  id: string;
  usuario_id: string;
  rol_id: number;
  ambito: 'novaciel' | 'cliente';
  cliente_id: string | null;
  creado_en: Date;
}

/** Assigns a role to a user. The role is always looked up by codigo; its ambito is copied into the row. */
export async function assignRole(
  db: Db,
  params: { usuarioId: string; rolCodigo: string; clienteId?: string | null },
): Promise<UsuarioRolRow> {
  const { rows } = await db.query<UsuarioRolRow>(
    `INSERT INTO usuario_roles (usuario_id, rol_id, ambito, cliente_id)
     SELECT $1, r.id, r.ambito, $3 FROM roles r WHERE r.codigo = $2
     RETURNING *`,
    [params.usuarioId, params.rolCodigo, params.clienteId ?? null],
  );
  const row = rows[0];
  if (!row) throw new Error(`Unknown role codigo "${params.rolCodigo}"`);
  return row;
}
