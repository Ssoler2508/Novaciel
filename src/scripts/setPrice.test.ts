import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { assignRole, createUsuario, uniqueSuffix } from '../../tests/utils/factories/index.js';
import { PermissionDeniedError, PriceExistsError } from '../modules/precios/preciosRepository.js';
import { assertAdminDatabaseAllowed } from './adminGuard.js';
import { parseSetPriceArgs } from './setPriceArgs.js';
import { setPriceAsAdmin } from './setPriceCore.js';

const base = ['--provider', 'fake_p', '--model', 'fake-m', '--input', '3', '--output', '15.5', '--admin-email', 'a@example.test'];

describe('parseSetPriceArgs', () => {
  it('parses amounts as exact micro-USD from strings, in both syntaxes', () => {
    const a = parseSetPriceArgs(base);
    expect(a).toMatchObject({ provider: 'fake_p', model: 'fake-m', inputPerMillion: 3_000_000n, outputPerMillion: 15_500_000n, adminEmail: 'a@example.test' });
    expect(a.nota).toBeUndefined();
    const b = parseSetPriceArgs(['--provider=p', '--model=m', '--input=0.000001', '--output=0', '--admin-email=a@example.test', '--nota', 'FAKE test price']);
    expect(b).toMatchObject({ inputPerMillion: 1n, outputPerMillion: 0n, nota: 'FAKE test price' });
  });

  it('rejects missing, repeated, unknown and invalid options', () => {
    const without = (flag: string) => {
      const i = base.indexOf(flag);
      return [...base.slice(0, i), ...base.slice(i + 2)];
    };
    for (const flag of ['--provider', '--model', '--input', '--output', '--admin-email']) {
      expect(() => parseSetPriceArgs(without(flag))).toThrow(new RegExp(`${flag}`));
    }
    expect(() => parseSetPriceArgs([...base, '--input', '1'])).toThrow(/more than once/);
    expect(() => parseSetPriceArgs([...base, '--force', 'x'])).toThrow(/Unknown option/);
    expect(() => parseSetPriceArgs([...base, 'positional'])).toThrow(/Unexpected argument/);
    expect(() => parseSetPriceArgs([...base.slice(0, 5), '--input'])).toThrow();
  });

  it('rejects amounts that are not plain non-negative decimals with at most 6 decimals, without echoing them', () => {
    for (const bad of ['-1', '1e3', 'NaN', '1.1234567', 'abc', '1,5', '.5']) {
      const argv = base.map((v, i) => (base[i - 1] === '--input' ? bad : v));
      let message = '';
      try {
        parseSetPriceArgs(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/--input must be/);
      expect(message).not.toContain(bad);
    }
  });
});

describe('set-price database guard', () => {
  it('uses the create-admin guard: refuses *_test databases', () => {
    const url = (name: string) => `postgresql://fakeuser:fakepassword@localhost:5432/${name}`;
    expect(() => assertAdminDatabaseAllowed(url('fake_test'))).toThrow(/"fake_test"/);
    expect(assertAdminDatabaseAllowed(url('fake_dev'))).toBe('fake_dev');
  });
});

describe('setPriceAsAdmin', () => {
  const args = () => {
    const suffix = uniqueSuffix();
    return parseSetPriceArgs(['--provider', `fake_p_${suffix}`, '--model', 'fake-m', '--input', '3', '--output', '15', '--admin-email', 'x@example.test', '--nota', 'FAKE test price']);
  };

  it('writes the price once, as the administrator, with the real audit row', async () => {
    await withTestTransaction(async (db) => {
      const admin = await createUsuario(db, { email: `admin-${uniqueSuffix()}@example.test` });
      await assignRole(db, { usuarioId: admin.id, rolCodigo: 'administrador_novaciel' });
      const a = { ...args(), adminEmail: admin.email.toUpperCase() };
      const price = await setPriceAsAdmin(db, a);
      expect(price).toMatchObject({ provider: a.provider, model: 'fake-m', inputPerMillion: 3_000_000n, outputPerMillion: 15_000_000n, nota: 'FAKE test price' });
      const { rows } = await db.query('SELECT creado_por FROM precios_modelos WHERE id = $1', [price.id]);
      expect(rows).toEqual([{ creado_por: admin.id }]);
      const audit = await db.query(`SELECT actor_tipo, actor_usuario_id, accion FROM auditoria WHERE tabla = 'precios_modelos' AND fila_id = $1`, [price.id]);
      expect(audit.rows).toEqual([{ actor_tipo: 'usuario', actor_usuario_id: admin.id, accion: 'crear' }]);
      // Inside one transaction now() is constant: a second price for the same instant is a duplicate.
      await expect(setPriceAsAdmin(db, { ...a, inputPerMillion: 9n })).rejects.toThrow(PriceExistsError);
      expect((await db.query('SELECT 1 FROM precios_modelos WHERE proveedor = $1', [a.provider])).rows).toHaveLength(1);
    });
  });

  it('refuses a user who is not an administrator, an unknown email and an inactive user; nothing is written', async () => {
    await withTestTransaction(async (db) => {
      const operator = await createUsuario(db, { email: `op-${uniqueSuffix()}@example.test` });
      await assignRole(db, { usuarioId: operator.id, rolCodigo: 'operador_novaciel' });
      const nobody = await createUsuario(db, { email: `nobody-${uniqueSuffix()}@example.test` });
      const inactive = await createUsuario(db, { email: `off-${uniqueSuffix()}@example.test`, activo: false });
      await assignRole(db, { usuarioId: inactive.id, rolCodigo: 'administrador_novaciel' });
      const a = args();
      for (const user of [operator, nobody]) {
        await expect(setPriceAsAdmin(db, { ...a, adminEmail: user.email })).rejects.toThrow(PermissionDeniedError);
      }
      await expect(setPriceAsAdmin(db, { ...a, adminEmail: inactive.email })).rejects.toThrow(/No active user/);
      await expect(setPriceAsAdmin(db, { ...a, adminEmail: 'missing@example.test' })).rejects.toThrow(/No active user/);
      expect((await db.query('SELECT 1 FROM precios_modelos WHERE proveedor = $1', [a.provider])).rows).toHaveLength(0);
      expect((await db.query(`SELECT 1 FROM auditoria WHERE tabla = 'precios_modelos'`)).rows).toHaveLength(0);
    });
  });
});
