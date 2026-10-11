import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { createUsuario as createUsuarioRow } from '../../../tests/utils/factories/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { createCliente, getClienteById, updateClienteEstado } from './clientesRepository.js';
import {
  createUsuario,
  getUsuarioByEmail,
  getUsuarioById,
  setUsuarioActivo,
} from '../usuarios/usuariosRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;

describe('clientesRepository', () => {
  it('creates and reads a client, with one audit row carrying its own cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuarioRow(db);
      const actor = { tipo: 'usuario', usuarioId: usuario.id } as const;
      const cliente = await createCliente(db, { nombreComercial: 'Café Ficticio' }, actor);
      expect(cliente.estado).toBe('en_onboarding');
      expect(await getClienteById(db, cliente.id)).toMatchObject({ nombre_comercial: 'Café Ficticio' });
      const audit = await auditRowsFor(db, 'clientes', cliente.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        accion: 'crear',
        cliente_id: cliente.id,
        actor_tipo: 'usuario',
        actor_usuario_id: usuario.id,
        datos_antes: null,
      });
    });
  });

  it('returns null for an unknown client', async () => {
    await withTestTransaction(async (db) => {
      expect(await getClienteById(db, asClienteId('00000000-0000-4000-8000-000000000000'))).toBeNull();
    });
  });

  it('updates estado with one audit row holding before and after', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db, { nombreComercial: 'Negocio Ficticio' }, SISTEMA);
      const updated = await updateClienteEstado(db, cliente.id, 'activo', SISTEMA);
      expect(updated?.estado).toBe('activo');
      const audit = await auditRowsFor(db, 'clientes', cliente.id);
      expect(audit.map((a) => a.accion)).toEqual(['crear', 'cambiar_estado']);
      expect(audit[1]).toMatchObject({ datos_antes: { estado: 'en_onboarding' }, datos_despues: { estado: 'activo' } });
    });
  });

  it('writes no audit row for an unknown client', async () => {
    await withTestTransaction(async (db) => {
      const unknown = asClienteId('00000000-0000-4000-8000-000000000000');
      expect(await updateClienteEstado(db, unknown, 'activo', SISTEMA)).toBeNull();
      expect(await auditRowsFor(db, 'clientes', unknown)).toHaveLength(0);
    });
  });
});

describe('usuariosRepository', () => {
  it('creates a user with an audit row with NULL cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db, { email: 'Persona@Example.test', nombre: 'Persona Ficticia' }, SISTEMA);
      expect(usuario.activo).toBe(true);
      const audit = await auditRowsFor(db, 'usuarios', usuario.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ accion: 'crear', cliente_id: null });
    });
  });

  it('looks users up by id and by email ignoring case', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db, { email: 'Persona@Example.test', nombre: 'Persona Ficticia' }, SISTEMA);
      expect((await getUsuarioById(db, usuario.id))?.id).toBe(usuario.id);
      expect((await getUsuarioByEmail(db, 'persona@EXAMPLE.test'))?.id).toBe(usuario.id);
      expect(await getUsuarioByEmail(db, 'nadie@example.test')).toBeNull();
    });
  });

  it('toggles activo with one audit row and writes nothing for an unknown user', async () => {
    await withTestTransaction(async (db) => {
      const usuario = await createUsuario(db, { email: 'a@example.test', nombre: 'A Ficticio' }, SISTEMA);
      const updated = await setUsuarioActivo(db, usuario.id, false, SISTEMA);
      expect(updated?.activo).toBe(false);
      const audit = await auditRowsFor(db, 'usuarios', usuario.id);
      expect(audit.map((a) => a.accion)).toEqual(['crear', 'cambiar_activo']);
      expect(audit[1]).toMatchObject({ cliente_id: null, datos_antes: { activo: true }, datos_despues: { activo: false } });

      const unknown = '00000000-0000-4000-8000-000000000000';
      expect(await setUsuarioActivo(db, unknown, false, SISTEMA)).toBeNull();
      expect(await auditRowsFor(db, 'usuarios', unknown)).toHaveLength(0);
    });
  });
});
