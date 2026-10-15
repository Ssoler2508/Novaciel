/** The part of a role assignment that decides access (a UserRole fits). */
export interface RoleAssignment {
  rol: string;
  clienteId: string | null;
}

// The permission matrix (spec section 14), as data. This is the only place that decides which
// role may do what; the Roles table of the spec says permissions are assigned by role, never
// person by person. Rows marked "proposal" in docs were approved by the developer.
//
// NovaCiel roles act on every client (their assignment has no cliente_id) and are limited by
// action. Client roles count only for the cliente_id of their own assignment.
//
// NOT in this matrix on purpose: decrypting a stored network secret (getSecretForUse in
// conexionesRedes). That is a system-only operation. It is never granted to any role, must never
// be reachable from an HTTP route, and its result must never be returned in any response.
// `manage_connections` covers create, rotate and revoke only.

export const ROLE_CODES = [
  'administrador_novaciel',
  'operador_novaciel',
  'dueno_cliente',
  'aprobador_cliente',
  'colaborador_cliente',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

const NOVACIEL_ROLES: readonly RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];

export type Action =
  | 'read_client_data'
  | 'edit_brand_profile'
  | 'upload_material'
  | 'approve_internal'
  | 'approve_as_client'
  | 'manage_connections'
  | 'manage_users'
  | 'manage_plans'
  | 'view_spend'
  | 'manage_budget'
  | 'manage_novaciel_staff';

export interface ActionRule {
  /** "client": needs a cliente_id. "global": no client; only NovaCiel roles can hold it. */
  scope: 'client' | 'global';
  roles: readonly RoleCode[];
}

export const PERMISSIONS: Record<Action, ActionRule> = {
  // Profile, library, plan, pieces, results.
  read_client_data: {
    scope: 'client',
    roles: ['administrador_novaciel', 'operador_novaciel', 'dueno_cliente', 'aprobador_cliente'],
  },
  // Brand profile, verified facts, prohibited rules.
  edit_brand_profile: {
    scope: 'client',
    roles: ['administrador_novaciel', 'operador_novaciel', 'dueno_cliente'],
  },
  upload_material: {
    scope: 'client',
    roles: ['administrador_novaciel', 'operador_novaciel', 'dueno_cliente', 'aprobador_cliente', 'colaborador_cliente'],
  },
  // NovaCiel review queue.
  approve_internal: { scope: 'client', roles: ['administrador_novaciel', 'operador_novaciel'] },
  // Client-side approval of plan and pieces. NovaCiel staff cannot approve in the client's name.
  approve_as_client: { scope: 'client', roles: ['dueno_cliente', 'aprobador_cliente'] },
  // conexiones_redes: create, rotate, revoke. Never "use" (see the note at the top).
  manage_connections: { scope: 'client', roles: ['administrador_novaciel', 'dueno_cliente'] },
  // Assign and revoke client roles, name approvers.
  manage_users: { scope: 'client', roles: ['administrador_novaciel', 'dueno_cliente'] },
  // Generate a client's weekly plan (a paid model call) and pause or resume its pieces. NovaCiel
  // staff only: the client's approver receives the plan and approves it (spec 7, 14).
  manage_plans: { scope: 'client', roles: ['administrador_novaciel', 'operador_novaciel'] },
  view_spend: { scope: 'client', roles: ['administrador_novaciel', 'operador_novaciel'] },
  // Prices, caps and switches.
  manage_budget: { scope: 'global', roles: ['administrador_novaciel'] },
  // Assign NovaCiel roles.
  manage_novaciel_staff: { scope: 'global', roles: ['administrador_novaciel'] },
};

export const ACTIONS = Object.keys(PERMISSIONS) as Action[];

function isNovaCielRole(rol: string): boolean {
  return (NOVACIEL_ROLES as readonly string[]).includes(rol);
}

/** True when one of the user's role assignments grants `action` (for `clienteId`, if client-scoped). */
export function can(roles: readonly RoleAssignment[], action: Action, clienteId?: string | null): boolean {
  const rule = PERMISSIONS[action];
  const granted = (rol: string) => (rule.roles as readonly string[]).includes(rol);
  if (rule.scope === 'global') {
    return roles.some((r) => isNovaCielRole(r.rol) && granted(r.rol));
  }
  if (!clienteId) return false;
  return roles.some((r) => granted(r.rol) && (isNovaCielRole(r.rol) || r.clienteId === clienteId));
}
