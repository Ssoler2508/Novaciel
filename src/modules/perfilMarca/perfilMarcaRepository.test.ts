import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { createCliente, createUsuario } from '../../../tests/utils/factories/index.js';
import { asClienteId } from '../shared/clienteId.js';
import * as repo from './perfilMarcaRepository.js';
import { PERFIL_BLOCKS, createNewVersion, getCurrentPerfilMarca } from './perfilMarcaRepository.js';

describe('perfilMarcaRepository', () => {
  it('has no update or delete function', () => {
    expect(Object.keys(repo).filter((name) => /^(update|delete|remove|set)/i.test(name))).toEqual([]);
  });

  it('returns null when the client has no profile', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      expect(await getCurrentPerfilMarca(db, asClienteId(cliente.id))).toBeNull();
    });
  });

  it('creates the first version with one audit row (no before image)', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const autor = await createUsuario(db);
      const v1 = await createNewVersion(db, clienteId, {
        creadoPor: autor.id,
        identidad: { nombre: 'Café Ficticio' },
        idiomaContenido: 'es',
      });
      expect(v1).toMatchObject({ version: 1, es_actual: true, idioma_contenido: 'es', creado_por: autor.id });
      expect(v1.voz).toEqual({});
      expect((await getCurrentPerfilMarca(db, clienteId))?.id).toBe(v1.id);
      const audit = await auditRowsFor(db, 'perfil_marca', v1.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        accion: 'crear_version',
        cliente_id: clienteId,
        actor_tipo: 'usuario',
        actor_usuario_id: autor.id,
        datos_antes: null,
      });
    });
  });

  it('after a new version only the latest is current and the old one still exists', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const autor = await createUsuario(db);
      const v1 = await createNewVersion(db, clienteId, { creadoPor: autor.id, identidad: { nombre: 'Uno' } });
      const v2 = await createNewVersion(db, clienteId, { creadoPor: autor.id, voz: { trato: 'tu' } });
      expect(v2.version).toBe(2);
      expect((await getCurrentPerfilMarca(db, clienteId))?.id).toBe(v2.id);
      const { rows } = await db.query('SELECT id, version, es_actual FROM perfil_marca WHERE cliente_id = $1 ORDER BY version', [
        clienteId,
      ]);
      expect(rows).toEqual([
        { id: v1.id, version: 1, es_actual: false },
        { id: v2.id, version: 2, es_actual: true },
      ]);
      // The old version's content is untouched.
      const old = (await db.query('SELECT identidad FROM perfil_marca WHERE id = $1', [v1.id])).rows[0];
      expect(old.identidad).toEqual({ nombre: 'Uno' });
    });
  });

  it('carries over blocks that are not given and audits before/after', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const autor = await createUsuario(db);
      const v1 = await createNewVersion(db, clienteId, {
        creadoPor: autor.id,
        identidad: { nombre: 'Uno' },
        idiomaContenido: 'en',
      });
      const v2 = await createNewVersion(db, clienteId, { creadoPor: autor.id, voz: { trato: 'tu' } });
      expect(v2.identidad).toEqual({ nombre: 'Uno' });
      expect(v2.voz).toEqual({ trato: 'tu' });
      expect(v2.idioma_contenido).toBe('en');
      const audit = await auditRowsFor(db, 'perfil_marca', v2.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.datos_antes).toMatchObject({ id: v1.id, version: 1 });
      expect(audit[0]?.datos_despues).toMatchObject({ id: v2.id, version: 2 });
      const unset = await createNewVersion(db, clienteId, { creadoPor: autor.id, idiomaContenido: null });
      expect(unset.idioma_contenido).toBeNull();
    });
  });

  it('a partial change copies every other block and idiomaContenido from the current version', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const autor = await createUsuario(db);
      const full = Object.fromEntries(PERFIL_BLOCKS.map((name) => [name, { campo: name }]));
      await createNewVersion(db, clienteId, { creadoPor: autor.id, idiomaContenido: 'ambos', ...full });
      const v2 = await createNewVersion(db, clienteId, { creadoPor: autor.id, voz: { campo: 'nuevo' } });
      for (const name of PERFIL_BLOCKS) {
        expect(v2[name]).toEqual(name === 'voz' ? { campo: 'nuevo' } : { campo: name });
      }
      expect(v2.idioma_contenido).toBe('ambos');
    });
  });

  it('an explicit null idiomaContenido clears it, while omitting it keeps it', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const autor = await createUsuario(db);
      await createNewVersion(db, clienteId, { creadoPor: autor.id, idiomaContenido: 'es' });
      const kept = await createNewVersion(db, clienteId, { creadoPor: autor.id });
      expect(kept.idioma_contenido).toBe('es');
      const cleared = await createNewVersion(db, clienteId, { creadoPor: autor.id, idiomaContenido: null });
      expect(cleared.idioma_contenido).toBeNull();
    });
  });

  it('an explicit empty object clears a block, leaving the others untouched', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const autor = await createUsuario(db);
      await createNewVersion(db, clienteId, {
        creadoPor: autor.id,
        identidad: { nombre: 'Uno' },
        voz: { trato: 'tu' },
      });
      const v2 = await createNewVersion(db, clienteId, { creadoPor: autor.id, voz: {} });
      expect(v2.voz).toEqual({});
      expect(v2.identidad).toEqual({ nombre: 'Uno' });
    });
  });

  it('an explicit null block is rejected instead of silently carried over', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const autor = await createUsuario(db);
      const v1 = await createNewVersion(db, clienteId, { creadoPor: autor.id, voz: { trato: 'tu' } });
      await expect(
        createNewVersion(db, clienteId, { creadoPor: autor.id, voz: null as never }),
      ).rejects.toThrow(/Block "voz" cannot be null/);
      expect((await getCurrentPerfilMarca(db, clienteId))?.id).toBe(v1.id);
    });
  });

  it('keeps clients separate', async () => {
    await withTestTransaction(async (db) => {
      const a = asClienteId((await createCliente(db)).id);
      const b = asClienteId((await createCliente(db)).id);
      const autor = await createUsuario(db);
      await createNewVersion(db, a, { creadoPor: autor.id });
      const bv1 = await createNewVersion(db, b, { creadoPor: autor.id });
      await createNewVersion(db, a, { creadoPor: autor.id });
      expect((await getCurrentPerfilMarca(db, b))?.id).toBe(bv1.id);
      expect(bv1.version).toBe(1);
    });
  });

  it('is atomic: a failing insert leaves the previous version current and no audit row', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      const autor = await createUsuario(db);
      const v1 = await createNewVersion(db, clienteId, { creadoPor: autor.id });
      await expect(
        createNewVersion(db, clienteId, { creadoPor: autor.id, idiomaContenido: 'fr' as never }),
      ).rejects.toMatchObject({ code: '23514' });
      expect((await getCurrentPerfilMarca(db, clienteId))?.id).toBe(v1.id);
      const { rows } = await db.query(`SELECT count(*) AS n FROM auditoria WHERE tabla = 'perfil_marca' AND cliente_id = $1`, [
        clienteId,
      ]);
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  it('requires an existing creado_por and an existing client', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = asClienteId((await createCliente(db)).id);
      await expect(
        createNewVersion(db, clienteId, { creadoPor: '00000000-0000-4000-8000-000000000000' }),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        createNewVersion(db, asClienteId('00000000-0000-4000-8000-000000000000'), { creadoPor: (await createUsuario(db)).id }),
      ).rejects.toThrow(/does not exist/);
    });
  });

  it('creado_por is required by the type (checked by npm run typecheck)', () => {
    const typeChecks = async (db: Parameters<typeof createNewVersion>[0], id: ReturnType<typeof asClienteId>) => {
      // @ts-expect-error creadoPor is required
      await createNewVersion(db, id, {});
    };
    expect(typeof typeChecks).toBe('function');
  });
});
