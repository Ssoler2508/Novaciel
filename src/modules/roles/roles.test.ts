import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { createCliente, createUsuario } from '../../../tests/utils/factories/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { getRoleByCodigo, listRoles } from './rolesRepository.js';
import {
  assignClientRole,
  assignNovaCielRole,
  hasNovaCielRole,
  listClientUsers,
  revokeClientRole,
  revokeNovaCielRole,
} from './usuarioRolesRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;

describe('rolesRepository', () => {
  it('lists the five roles and finds one by codigo', async () => {
    await withTestTransaction(async (db) => {
      expect((await listRoles(db)).map((r) => r.codigo)).toEqual([
        'administrador_novaciel',
        'operador_novaciel',
        'dueno_cliente',
        'aprobador_cliente',
        'colaborador_cliente',
      ]);
      expect(await getRoleByCodigo(db, 'dueno_cliente')).toMatchObject({ ambito: 'cliente' });
      expect(await getRoleByCodigo(db, 'Dueño del cliente')).toBeNull();
    });
  });
});

describe('client role assignments', () => {
  it('assigns a client role with one audit row carrying the client', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const usuario = await createUsuario(db);
      const clienteId = asClienteId(cliente.id);
      const row = await assignClientRole(db, clienteId, { usuarioId: usuario.id, rolCodigo: 'dueno_cliente' }, SISTEMA);
      expect(row).toMatchObject({ ambito: 'cliente', cliente_id: cliente.id });
      const audit = await auditRowsFor(db, 'usuario_roles', row.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        accion: 'asignar_rol',
        cliente_id: cliente.id,
        datos_despues: { rol_codigo: 'dueno_cliente' },
      });
    });
  });

  it('refuses a NovaCiel role through the client function and unknown roles', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const usuario = await createUsuario(db);
      const clienteId = asClienteId(cliente.id);
      await expect(
        assignClientRole(db, clienteId, { usuarioId: usuario.id, rolCodigo: 'administrador_novaciel' }, SISTEMA),
      ).rejects.toThrow(/not a cliente role/);
      await expect(
        assignClientRole(db, clienteId, { usuarioId: usuario.id, rolCodigo: 'inexistente' }, SISTEMA),
      ).rejects.toThrow(/Unknown role/);
    });
  });

  it('rejects a duplicate assignment and leaves no audit row for it', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const usuario = await createUsuario(db);
      const clienteId = asClienteId(cliente.id);
      const params = { usuarioId: usuario.id, rolCodigo: 'aprobador_cliente' };
      const first = await assignClientRole(db, clienteId, params, SISTEMA);
      await expect(assignClientRole(db, clienteId, params, SISTEMA)).rejects.toMatchObject({ code: '23505' });
      const { rows } = await db.query(`SELECT count(*) AS n FROM auditoria WHERE tabla = 'usuario_roles' AND cliente_id = $1`, [
        cliente.id,
      ]);
      expect(Number(rows[0].n)).toBe(1);
      expect((await auditRowsFor(db, 'usuario_roles', first.id)).length).toBe(1);
    });
  });

  it('lists only the users of that client with their roles', async () => {
    await withTestTransaction(async (db) => {
      const a = asClienteId((await createCliente(db)).id);
      const b = asClienteId((await createCliente(db)).id);
      const ana = await createUsuario(db, { email: 'ana@example.test' });
      const beto = await createUsuario(db, { email: 'beto@example.test' });
      await assignClientRole(db, a, { usuarioId: ana.id, rolCodigo: 'dueno_cliente' }, SISTEMA);
      await assignClientRole(db, a, { usuarioId: ana.id, rolCodigo: 'aprobador_cliente' }, SISTEMA);
      await assignClientRole(db, b, { usuarioId: beto.id, rolCodigo: 'colaborador_cliente' }, SISTEMA);
      expect(await listClientUsers(db, a)).toEqual([
        { usuario_id: ana.id, email: 'ana@example.test', nombre: ana.nombre, roles: ['aprobador_cliente', 'dueno_cliente'] },
      ]);
      expect((await listClientUsers(db, b)).map((u) => u.usuario_id)).toEqual([beto.id]);
    });
  });

  it('revokes only within the client and audits once', async () => {
    await withTestTransaction(async (db) => {
      const a = asClienteId((await createCliente(db)).id);
      const b = asClienteId((await createCliente(db)).id);
      const usuario = await createUsuario(db);
      const params = { usuarioId: usuario.id, rolCodigo: 'colaborador_cliente' };
      const inB = await assignClientRole(db, b, params, SISTEMA);
      expect(await revokeClientRole(db, a, params, SISTEMA)).toBe(false);
      expect((await auditRowsFor(db, 'usuario_roles', inB.id)).map((r) => r.accion)).toEqual(['asignar_rol']);
      expect(await revokeClientRole(db, b, params, SISTEMA)).toBe(true);
      expect((await auditRowsFor(db, 'usuario_roles', inB.id)).map((r) => r.accion)).toEqual([
        'asignar_rol',
        'revocar_rol',
      ]);
      expect(await listClientUsers(db, b)).toEqual([]);
    });
  });
});

describe('NovaCiel role assignments', () => {
  it('assigns without a client and audits with NULL cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db);
      const row = await assignNovaCielRole(db, { usuarioId: usuario.id, rolCodigo: 'administrador_novaciel' }, SISTEMA);
      expect(row).toMatchObject({ ambito: 'novaciel', cliente_id: null });
      const audit = await auditRowsFor(db, 'usuario_roles', row.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ accion: 'asignar_rol', cliente_id: null });
    });
  });

  it('refuses a client role through the NovaCiel function', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db);
      await expect(
        assignNovaCielRole(db, { usuarioId: usuario.id, rolCodigo: 'dueno_cliente' }, SISTEMA),
      ).rejects.toThrow(/not a novaciel role/);
    });
  });

  it('rejects a duplicate and revokes with an audit row', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db);
      const params = { usuarioId: usuario.id, rolCodigo: 'operador_novaciel' };
      const row = await assignNovaCielRole(db, params, SISTEMA);
      await expect(assignNovaCielRole(db, params, SISTEMA)).rejects.toMatchObject({ code: '23505' });
      expect(await revokeNovaCielRole(db, params, SISTEMA)).toBe(true);
      expect(await revokeNovaCielRole(db, params, SISTEMA)).toBe(false);
      const audit = await auditRowsFor(db, 'usuario_roles', row.id);
      expect(audit.map((r) => r.accion)).toEqual(['asignar_rol', 'revocar_rol']);
      expect(audit[1]).toMatchObject({ cliente_id: null });
    });
  });
});

describe('ClienteId typing', () => {
  it('is required and branded (checked by npm run typecheck)', () => {
    // Never called: only the type errors matter.
    const typeChecks = async (db: Parameters<typeof listClientUsers>[0]) => {
      // @ts-expect-error clienteId is required, with no default
      await listClientUsers(db);
      // @ts-expect-error a plain string is not a ClienteId
      await listClientUsers(db, '11111111-1111-4111-8111-111111111111');
    };
    expect(typeof typeChecks).toBe('function');
  });
});

describe('hasNovaCielRole', () => {
  it('is true only for that user and that NovaCiel role', async () => {
    await withTestTransaction(async (db) => {
      const cliente = asClienteId((await createCliente(db)).id);
      const admin = await createUsuario(db);
      const other = await createUsuario(db);
      await assignNovaCielRole(db, { usuarioId: admin.id, rolCodigo: 'administrador_novaciel' }, SISTEMA);
      await assignClientRole(db, cliente, { usuarioId: other.id, rolCodigo: 'dueno_cliente' }, SISTEMA);
      expect(await hasNovaCielRole(db, admin.id, 'administrador_novaciel')).toBe(true);
      expect(await hasNovaCielRole(db, admin.id, 'operador_novaciel')).toBe(false);
      expect(await hasNovaCielRole(db, other.id, 'administrador_novaciel')).toBe(false);
      expect(await hasNovaCielRole(db, other.id, 'dueno_cliente')).toBe(false);
    });
  });
});
