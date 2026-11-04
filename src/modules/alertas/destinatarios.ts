import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';

// Who receives a notice. Shared by the approval reminders and the persistent alerts, so both use the same
// rules. Ids only: nothing here reads client text.

/** Active users who hold a NovaCiel role (administrators and operators), in a stable order. */
export async function listPersonalNovaciel(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT u.id FROM usuarios u JOIN usuario_roles ur ON ur.usuario_id = u.id
     WHERE u.activo AND ur.ambito = 'novaciel' ORDER BY u.id`,
  );
  return rows.map((r) => r.id);
}

/**
 * Re-validated when the notice goes out: the user is active, still holds an approval role FOR THIS CLIENT,
 * and holds no NovaCiel role (the same rule as the database guard of aprobadores_cliente).
 */
export async function esAprobadorValido(db: Db, clienteId: ClienteId, usuarioId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM usuarios u
     WHERE u.id = $1 AND u.activo
       AND EXISTS (SELECT 1 FROM usuario_roles ur JOIN roles r ON r.id = ur.rol_id
                   WHERE ur.usuario_id = u.id AND ur.cliente_id = $2 AND r.codigo IN ('dueno_cliente', 'aprobador_cliente'))
       AND NOT EXISTS (SELECT 1 FROM usuario_roles ur WHERE ur.usuario_id = u.id AND ur.ambito = 'novaciel')`,
    [usuarioId, clienteId],
  );
  return rows.length > 0;
}

/** Active owners of a client (role dueno_cliente for that client), in a stable order. */
export async function listDuenosCliente(db: Db, clienteId: ClienteId): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT u.id FROM usuarios u
     JOIN usuario_roles ur ON ur.usuario_id = u.id JOIN roles r ON r.id = ur.rol_id
     WHERE u.activo AND ur.cliente_id = $1 AND r.codigo = 'dueno_cliente' ORDER BY u.id`,
    [clienteId],
  );
  return rows.map((r) => r.id);
}

/** The client's main and substitute approvers that are still valid, in a stable order. */
export async function listAprobadoresValidos(db: Db, clienteId: ClienteId): Promise<string[]> {
  const { rows } = await db.query<{ principal: string; suplente: string | null }>(
    'SELECT principal_usuario_id AS principal, suplente_usuario_id AS suplente FROM aprobadores_cliente WHERE cliente_id = $1',
    [clienteId],
  );
  const candidatos = [...new Set([rows[0]?.principal, rows[0]?.suplente].filter((x): x is string => typeof x === 'string'))].sort();
  const validos: string[] = [];
  for (const id of candidatos) if (await esAprobadorValido(db, clienteId, id)) validos.push(id);
  return validos;
}
