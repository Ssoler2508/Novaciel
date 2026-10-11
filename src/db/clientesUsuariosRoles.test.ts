import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { cleanupDomainTables } from '../../tests/utils/cleanup.js';
import { getTestPool } from '../../tests/utils/testPool.js';
import { assignRole, createCliente, createUsuario } from '../../tests/utils/factories/index.js';

const ROLES = [
  ['administrador_novaciel', 'Administrador NovaCiel', 'novaciel'],
  ['operador_novaciel', 'Operador NovaCiel', 'novaciel'],
  ['dueno_cliente', 'Dueño del cliente', 'cliente'],
  ['aprobador_cliente', 'Aprobador del cliente', 'cliente'],
  ['colaborador_cliente', 'Colaborador del cliente', 'cliente'],
] as const;

async function readRoles(db: { query: (sql: string) => Promise<{ rows: unknown[] }> }) {
  const { rows } = await db.query('SELECT codigo, nombre, ambito FROM roles ORDER BY id');
  return (rows as { codigo: string; nombre: string; ambito: string }[]).map((r) => [r.codigo, r.nombre, r.ambito]);
}

describe('roles catalog', () => {
  it('contains the five roles of spec section 14', async () => {
    await withTestTransaction(async (db) => {
      expect(await readRoles(db)).toEqual(ROLES.map((r) => [...r]));
    });
  });

  it('survives cleanupDomainTables', async () => {
    await cleanupDomainTables(getTestPool());
    expect(await readRoles(getTestPool())).toEqual(ROLES.map((r) => [...r]));
  });

  it('rejects a duplicate or non-ASCII-slug codigo', async () => {
    await withTestTransaction(async (db) => {
      await expect(
        db.query(`INSERT INTO roles (codigo, nombre, ambito) VALUES ('dueno_cliente', 'Otro', 'cliente')`),
      ).rejects.toMatchObject({ code: '23505' });
    });
    await withTestTransaction(async (db) => {
      await expect(
        db.query(`INSERT INTO roles (codigo, nombre, ambito) VALUES ('Dueño', 'Otro', 'cliente')`),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});

describe('role assignments', () => {
  it('accepts a client role with a client and a NovaCiel role without one', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const usuario = await createUsuario(db);
      const owner = await assignRole(db, { usuarioId: usuario.id, rolCodigo: 'dueno_cliente', clienteId: cliente.id });
      const admin = await assignRole(db, { usuarioId: usuario.id, rolCodigo: 'administrador_novaciel' });
      expect(owner).toMatchObject({ ambito: 'cliente', cliente_id: cliente.id });
      expect(admin).toMatchObject({ ambito: 'novaciel', cliente_id: null });
    });
  });

  it('rejects a client role without cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db);
      await expect(assignRole(db, { usuarioId: usuario.id, rolCodigo: 'aprobador_cliente' })).rejects.toMatchObject({
        code: '23514',
      });
    });
  });

  it('rejects a NovaCiel role with cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const usuario = await createUsuario(db);
      await expect(
        assignRole(db, { usuarioId: usuario.id, rolCodigo: 'operador_novaciel', clienteId: cliente.id }),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects a mismatched ambito through the composite foreign key', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db);
      await expect(
        db.query(
          `INSERT INTO usuario_roles (usuario_id, rol_id, ambito, cliente_id)
           SELECT $1, id, 'novaciel', NULL FROM roles WHERE codigo = 'dueno_cliente'`,
          [usuario.id],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('rejects a duplicate client-role assignment', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const usuario = await createUsuario(db);
      const params = { usuarioId: usuario.id, rolCodigo: 'colaborador_cliente', clienteId: cliente.id };
      await assignRole(db, params);
      await expect(assignRole(db, params)).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('rejects a duplicate NovaCiel-role assignment with NULL cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db);
      await assignRole(db, { usuarioId: usuario.id, rolCodigo: 'administrador_novaciel' });
      await expect(assignRole(db, { usuarioId: usuario.id, rolCodigo: 'administrador_novaciel' })).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  it('allows the same role for the same user in different clients', async () => {
    await withTestTransaction(async (db) => {
      const a = await createCliente(db);
      const b = await createCliente(db);
      const usuario = await createUsuario(db);
      await assignRole(db, { usuarioId: usuario.id, rolCodigo: 'aprobador_cliente', clienteId: a.id });
      await expect(
        assignRole(db, { usuarioId: usuario.id, rolCodigo: 'aprobador_cliente', clienteId: b.id }),
      ).resolves.toBeDefined();
    });
  });

  it('rejects an unknown cliente_id and deleting a referenced client (RESTRICT)', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db);
      await expect(
        assignRole(db, {
          usuarioId: usuario.id,
          rolCodigo: 'dueno_cliente',
          clienteId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toMatchObject({ code: '23503' });
    });
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const usuario = await createUsuario(db);
      await assignRole(db, { usuarioId: usuario.id, rolCodigo: 'dueno_cliente', clienteId: cliente.id });
      await expect(db.query('DELETE FROM clientes WHERE id = $1', [cliente.id])).rejects.toMatchObject({ code: '23001' });
    });
  });
});

describe('clientes constraints', () => {
  it('rejects a blank nombre_comercial and an invalid estado', async () => {
    await withTestTransaction(async (db) => {
      await expect(createCliente(db, { nombre_comercial: '   ' })).rejects.toMatchObject({ code: '23514' });
    });
    await withTestTransaction(async (db) => {
      await expect(createCliente(db, { estado: 'borrado' as never })).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('defaults estado to en_onboarding and allows repeated trade names', async () => {
    await withTestTransaction(async (db) => {
      const first = await createCliente(db, { nombre_comercial: 'Café Ficticio' });
      const second = await createCliente(db, { nombre_comercial: 'Café Ficticio' });
      expect(first.estado).toBe('en_onboarding');
      expect(second.id).not.toBe(first.id);
    });
  });
});

describe('usuarios constraints', () => {
  it('rejects a duplicate email regardless of case', async () => {
    await withTestTransaction(async (db) => {
      await createUsuario(db, { email: 'Persona@Example.test' });
      await expect(createUsuario(db, { email: 'persona@example.TEST' })).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('rejects a blank email and a blank nombre', async () => {
    await withTestTransaction(async (db) => {
      await expect(createUsuario(db, { email: ' ' })).rejects.toMatchObject({ code: '23514' });
    });
    await withTestTransaction(async (db) => {
      await expect(createUsuario(db, { nombre: '' })).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('has no cliente_id column (global table)', async () => {
    await withTestTransaction(async (db) => {
      const { rows } = await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name = 'cliente_id'`,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
