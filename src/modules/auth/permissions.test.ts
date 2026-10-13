import { describe, expect, it } from 'vitest';
import { ACTIONS, can, PERMISSIONS, ROLE_CODES, type Action, type RoleCode } from './permissions.js';

// The approved matrix, written out here on purpose (not derived from PERMISSIONS): a wrong edit of
// the data file must fail this test.
const A = 'administrador_novaciel';
const O = 'operador_novaciel';
const D = 'dueno_cliente';
const P = 'aprobador_cliente';
const C = 'colaborador_cliente';

const EXPECTED: Record<Action, { scope: 'client' | 'global'; allowed: RoleCode[] }> = {
  read_client_data: { scope: 'client', allowed: [A, O, D, P] },
  edit_brand_profile: { scope: 'client', allowed: [A, O, D] },
  upload_material: { scope: 'client', allowed: [A, O, D, P, C] },
  approve_internal: { scope: 'client', allowed: [A, O] },
  approve_as_client: { scope: 'client', allowed: [D, P] },
  manage_connections: { scope: 'client', allowed: [A, D] },
  manage_users: { scope: 'client', allowed: [A, D] },
  view_spend: { scope: 'client', allowed: [A, O] },
  manage_budget: { scope: 'global', allowed: [A] },
  manage_novaciel_staff: { scope: 'global', allowed: [A] },
};

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOVACIEL: RoleCode[] = [A, O];

const assignment = (rol: string, clienteId: string | null) => [
  { rol, clienteId: (NOVACIEL as string[]).includes(rol) ? null : clienteId },
];

describe('permission matrix', () => {
  it('covers exactly the approved actions and scopes', () => {
    expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const action of ACTIONS) expect(PERMISSIONS[action].scope).toBe(EXPECTED[action].scope);
  });

  it.each(Object.entries(EXPECTED))('%s: each of the 5 roles gets the approved answer', (action, expected) => {
    for (const rol of ROLE_CODES) {
      const result = can(assignment(rol, CLIENT), action as Action, expected.scope === 'client' ? CLIENT : undefined);
      expect(result, `${rol} on ${action}`).toBe(expected.allowed.includes(rol));
    }
  });

  it('client roles count only for their own client; NovaCiel roles for every client', () => {
    for (const rol of [D, P, C]) {
      expect(can(assignment(rol, CLIENT), 'upload_material', OTHER)).toBe(false);
    }
    for (const rol of NOVACIEL) expect(can(assignment(rol, null), 'upload_material', OTHER)).toBe(true);
  });

  it('a client-scoped action without a client id is denied, even for NovaCiel roles', () => {
    for (const rol of ROLE_CODES) expect(can(assignment(rol, CLIENT), 'read_client_data')).toBe(false);
    expect(can(assignment(A, null), 'read_client_data', null)).toBe(false);
  });

  it('client roles never hold a global action, whatever client they have', () => {
    for (const rol of [D, P, C]) {
      expect(can(assignment(rol, CLIENT), 'manage_budget')).toBe(false);
      expect(can(assignment(rol, CLIENT), 'manage_novaciel_staff', CLIENT)).toBe(false);
    }
  });

  it('a user with no roles can do nothing', () => {
    for (const action of ACTIONS) expect(can([], action, CLIENT)).toBe(false);
  });

  it('decrypting a network secret is not an action any role can hold', () => {
    expect(ACTIONS.filter((a) => /secret|decrypt|use_/i.test(a))).toEqual([]);
  });
});
