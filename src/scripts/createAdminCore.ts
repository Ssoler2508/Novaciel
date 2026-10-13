import type { Db } from '../db/types.js';
import { runInTransaction } from '../db/transaction.js';
import { assertPasswordPolicy } from '../lib/crypto/passwords.js';
import type { AuditActor } from '../modules/auditoria/recordAudit.js';
import { assignNovaCielRole, hasNovaCielRole } from '../modules/roles/usuarioRolesRepository.js';
import { createUsuario, getUsuarioByEmail, setPassword, setUsuarioActivo } from '../modules/usuarios/usuariosRepository.js';

const SISTEMA: AuditActor = { tipo: 'sistema' };
export const ADMIN_ROLE = 'administrador_novaciel';
export const DEFAULT_ADMIN_NAME = 'Administrador NovaCiel';

export interface CreateAdminResult {
  usuarioId: string;
  created: boolean;
  reactivated: boolean;
  roleAssigned: boolean;
}

/**
 * Creates or updates a user by email, makes it active, gives it the administrador_novaciel role and
 * sets its password. Everything goes through the repositories (audited, actor sistema) in one
 * transaction. The password is checked against the policy before anything is written, and nothing
 * secret is returned or logged. Setting the password also clears any lockout and revokes sessions.
 * An existing user's name is never overwritten.
 */
export async function createOrUpdateAdmin(
  db: Db,
  params: { email: string; nombre?: string; password: string },
): Promise<CreateAdminResult> {
  assertPasswordPolicy(params.password);
  return runInTransaction(db, async (tx) => {
    let user = await getUsuarioByEmail(tx, params.email);
    const created = !user;
    user ??= await createUsuario(tx, { email: params.email, nombre: params.nombre ?? DEFAULT_ADMIN_NAME }, SISTEMA);

    const reactivated = !user.activo;
    if (reactivated) await setUsuarioActivo(tx, user.id, true, SISTEMA);

    const roleAssigned = !(await hasNovaCielRole(tx, user.id, ADMIN_ROLE));
    if (roleAssigned) await assignNovaCielRole(tx, { usuarioId: user.id, rolCodigo: ADMIN_ROLE }, SISTEMA);

    await setPassword(tx, user.id, params.password, SISTEMA);
    return { usuarioId: user.id, created, reactivated, roleAssigned };
  });
}
