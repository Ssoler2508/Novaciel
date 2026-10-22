import type { ClienteId } from '../shared/clienteId.js';
import { can, type Action } from '../auth/permissions.js';
import type { UserRole } from '../roles/usuarioRolesRepository.js';
import { PermisoDenegadoError } from './errors.js';

/** A logged-in user as the services see them: who, and the roles read for this request. */
export interface AprobadorActor {
  usuarioId: string;
  roles: readonly UserRole[];
}

const NOVACIEL_ROLES = ['administrador_novaciel', 'operador_novaciel'];
const CLIENT_APPROVAL_ROLES = ['dueno_cliente', 'aprobador_cliente'];

export const esPersonalNovaciel = (actor: AprobadorActor): boolean => actor.roles.some((r) => NOVACIEL_ROLES.includes(r.rol));

/** Throws PermisoDenegadoError unless the matrix grants `action` for this client. */
export function requireAction(actor: AprobadorActor, action: Action, clienteId: ClienteId): void {
  if (!can(actor.roles, action, clienteId)) throw new PermisoDenegadoError(action);
}

/**
 * The role a decision is recorded with. Interno: a NovaCiel approval role. Cliente: dueno_cliente or
 * aprobador_cliente FOR THIS CLIENT, and never a user who also holds a NovaCiel role (separation of
 * duties; the database refuses it too).
 */
export function rolParaNivel(actor: AprobadorActor, nivel: 'interno' | 'cliente', clienteId: ClienteId): string {
  if (nivel === 'interno') {
    requireAction(actor, 'approve_internal', clienteId);
    return actor.roles.find((r) => r.rol === 'administrador_novaciel')?.rol ?? 'operador_novaciel';
  }
  requireAction(actor, 'approve_as_client', clienteId);
  if (esPersonalNovaciel(actor)) throw new PermisoDenegadoError('approve_as_client');
  const rol = actor.roles.find((r) => CLIENT_APPROVAL_ROLES.includes(r.rol) && r.clienteId === clienteId);
  if (!rol) throw new PermisoDenegadoError('approve_as_client');
  return rol.rol;
}
