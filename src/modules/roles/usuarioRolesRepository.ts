import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';
import { getRoleByCodigo } from './rolesRepository.js';

export interface UsuarioRolRow {
  id: string;
  usuario_id: string;
  rol_id: number;
  ambito: 'novaciel' | 'cliente';
  cliente_id: ClienteId | null;
  creado_en: Date;
}

export interface ClientUserRoles {
  usuario_id: string;
  email: string;
  nombre: string;
  roles: string[];
}

async function requireRole(db: Db, rolCodigo: string, ambito: 'novaciel' | 'cliente') {
  const rol = await getRoleByCodigo(db, rolCodigo);
  if (!rol) throw new Error(`Unknown role "${rolCodigo}"`);
  if (rol.ambito !== ambito) throw new Error(`Role "${rolCodigo}" is not a ${ambito} role`);
  return rol;
}

/** Assigns a client role. A client role always has a client. */
export async function assignClientRole(
  db: Db,
  clienteId: ClienteId,
  params: { usuarioId: string; rolCodigo: string },
  actor: AuditActor,
): Promise<UsuarioRolRow> {
  return runInTransaction(db, async (tx) => {
    const rol = await requireRole(tx, params.rolCodigo, 'cliente');
    const { rows } = await tx.query<UsuarioRolRow>(
      `INSERT INTO usuario_roles (usuario_id, rol_id, ambito, cliente_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [params.usuarioId, rol.id, rol.ambito, clienteId],
    );
    const row = rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'asignar_rol',
      tabla: 'usuario_roles',
      filaId: row.id,
      clienteId,
      despues: { ...row, rol_codigo: rol.codigo },
    });
    return row;
  });
}

/** Assigns a NovaCiel role. It never has a client; the audit row has a NULL cliente_id. */
export async function assignNovaCielRole(
  db: Db,
  params: { usuarioId: string; rolCodigo: string },
  actor: AuditActor,
): Promise<UsuarioRolRow> {
  return runInTransaction(db, async (tx) => {
    const rol = await requireRole(tx, params.rolCodigo, 'novaciel');
    const { rows } = await tx.query<UsuarioRolRow>(
      `INSERT INTO usuario_roles (usuario_id, rol_id, ambito, cliente_id) VALUES ($1, $2, $3, NULL) RETURNING *`,
      [params.usuarioId, rol.id, rol.ambito],
    );
    const row = rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'asignar_rol',
      tabla: 'usuario_roles',
      filaId: row.id,
      clienteId: null,
      despues: { ...row, rol_codigo: rol.codigo },
    });
    return row;
  });
}

/** Revokes a client role. Filtered by cliente_id: it can never touch another client's assignment. */
export async function revokeClientRole(
  db: Db,
  clienteId: ClienteId,
  params: { usuarioId: string; rolCodigo: string },
  actor: AuditActor,
): Promise<boolean> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<UsuarioRolRow>(
      `DELETE FROM usuario_roles ur USING roles r
       WHERE ur.rol_id = r.id AND r.codigo = $3 AND ur.usuario_id = $1 AND ur.cliente_id = $2
       RETURNING ur.*`,
      [params.usuarioId, clienteId, params.rolCodigo],
    );
    const row = rows[0];
    if (!row) return false;
    await recordAudit(tx, {
      actor,
      accion: 'revocar_rol',
      tabla: 'usuario_roles',
      filaId: row.id,
      clienteId,
      antes: { ...row, rol_codigo: params.rolCodigo },
    });
    return true;
  });
}

export async function revokeNovaCielRole(
  db: Db,
  params: { usuarioId: string; rolCodigo: string },
  actor: AuditActor,
): Promise<boolean> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<UsuarioRolRow>(
      `DELETE FROM usuario_roles ur USING roles r
       WHERE ur.rol_id = r.id AND r.codigo = $2 AND r.ambito = 'novaciel'
         AND ur.usuario_id = $1 AND ur.cliente_id IS NULL
       RETURNING ur.*`,
      [params.usuarioId, params.rolCodigo],
    );
    const row = rows[0];
    if (!row) return false;
    await recordAudit(tx, {
      actor,
      accion: 'revocar_rol',
      tabla: 'usuario_roles',
      filaId: row.id,
      clienteId: null,
      antes: { ...row, rol_codigo: params.rolCodigo },
    });
    return true;
  });
}

/** Users of one client with their role codigos. Client-scoped. */
export async function listClientUsers(db: Db, clienteId: ClienteId): Promise<ClientUserRoles[]> {
  const { rows } = await db.query<{ usuario_id: string; email: string; nombre: string; codigo: string }>(
    `SELECT u.id AS usuario_id, u.email, u.nombre, r.codigo
     FROM usuario_roles ur
     JOIN usuarios u ON u.id = ur.usuario_id
     JOIN roles r ON r.id = ur.rol_id
     WHERE ur.cliente_id = $1
     ORDER BY u.email, r.codigo`,
    [clienteId],
  );
  const byUser = new Map<string, ClientUserRoles>();
  for (const row of rows) {
    const entry = byUser.get(row.usuario_id) ?? {
      usuario_id: row.usuario_id,
      email: row.email,
      nombre: row.nombre,
      roles: [],
    };
    entry.roles.push(row.codigo);
    byUser.set(row.usuario_id, entry);
  }
  return [...byUser.values()];
}
