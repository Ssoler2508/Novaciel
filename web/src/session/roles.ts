import type { UserRole } from '../api/auth.js';

const NOVACIEL_ROLE_CODES: readonly string[] = ['administrador_novaciel', 'operador_novaciel'];

export function hasNovaCielAccess(roles: readonly UserRole[]): boolean {
  return roles.some((role) => NOVACIEL_ROLE_CODES.includes(role.rol));
}
