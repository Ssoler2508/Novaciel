import type { UserRole } from '../api/auth.js';

// Approval level derived from /auth/me. There is no fallback: a user without a confirmed role for
// the client gets null, and the interface then offers no decision controls.

const NOVACIEL_ROLE_CODES: readonly string[] = ['administrador_novaciel', 'operador_novaciel'];
const CLIENT_APPROVAL_ROLE_CODES = ['dueno_cliente', 'aprobador_cliente'];

export function hasNovaCielRole(roles: readonly UserRole[]): boolean {
  return roles.some((role) => NOVACIEL_ROLE_CODES.includes(role.rol));
}

export function hasNovaCielAccess(roles: readonly UserRole[]): boolean {
  return hasNovaCielRole(roles);
}

/** The clients where the user may approve as a client, without duplicates. */
export function clientApprovalClients(roles: readonly UserRole[]): string[] {
  const clients = roles
    .filter((role) => CLIENT_APPROVAL_ROLE_CODES.includes(role.rol) && role.clienteId !== null)
    .map((role) => role.clienteId as string);
  return [...new Set(clients)];
}

/**
 * "interno" wins when a NovaCiel role is present (the backend also refuses client decisions for
 * those users). "cliente" needs an approval role for this exact client. No default.
 */
export function nivelAprobacion(roles: readonly UserRole[], clienteId: string): 'interno' | 'cliente' | null {
  if (hasNovaCielRole(roles)) return 'interno';
  const mayApprove = roles.some(
    (role) => CLIENT_APPROVAL_ROLE_CODES.includes(role.rol) && role.clienteId === clienteId,
  );
  return mayApprove ? 'cliente' : null;
}
