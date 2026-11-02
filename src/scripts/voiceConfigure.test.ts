import { describe, expect, it } from 'vitest';
import { assignRole, createCliente, createPerfilMarca, createUsuario, uniqueSuffix } from '../../tests/utils/factories/index.js';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import type { Db } from '../db/types.js';
import { ConfiguracionVozInvalidaError, vozDelCliente } from '../modules/locuciones/configuracionVoz.js';
import { getCurrentPerfilMarca } from '../modules/perfilMarca/perfilMarcaRepository.js';
import { asClienteId } from '../modules/shared/clienteId.js';
import { parseVoiceConfigureArgs } from './voiceConfigureArgs.js';
import { configureVoice } from './voiceConfigureCore.js';

const ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'admin@example.test';
const base = ['--cliente', ID, '--admin-email', EMAIL];

describe('parseVoiceConfigureArgs', () => {
  it('parses a voice with its optional settings, as numbers', () => {
    expect(parseVoiceConfigureArgs([...base, '--voz', 'Voz_1', '--idioma', 'es'])).toEqual({ clienteId: ID, adminEmail: EMAIL, desactivar: false, vozId: 'Voz_1', idioma: 'es' });
    expect(parseVoiceConfigureArgs([...base, '--voz=V', '--idioma=en', '--velocidad', '1.1', '--estabilidad=0.4', '--similitud', '0.9', '--estilo', '0'])).toMatchObject({ velocidad: 1.1, estabilidad: 0.4, similitud: 0.9, estilo: 0 });
  });

  it('--desactivar stands alone', () => {
    expect(parseVoiceConfigureArgs([...base, '--desactivar'])).toEqual({ clienteId: ID, adminEmail: EMAIL, desactivar: true });
    for (const extra of [['--voz', 'x'], ['--idioma', 'es'], ['--velocidad', '1']]) expect(() => parseVoiceConfigureArgs([...base, '--desactivar', ...extra])).toThrow(/does not apply/);
  });

  it('refuses missing, unknown, repeated and malformed options without echoing values', () => {
    for (const argv of [[], ['--cliente', ID], [...base], [...base, '--voz', 'V'], [...base, '--idioma', 'es'], [...base, '--voz', 'V', '--idioma', 'es', '--clonar', 'si'], [...base, '--voz', 'V', '--voz', 'W', '--idioma', 'es'], [...base, '--voz', 'V', '--idioma', 'es', '--velocidad', 'rapido'], [...base, '--voz', 'V', '--idioma', 'es', '--velocidad', '-1'], ['--cliente', 'x', '--admin-email', EMAIL, '--desactivar']]) {
      expect(() => parseVoiceConfigureArgs(argv), JSON.stringify(argv)).toThrow();
    }
    let message = '';
    try {
      parseVoiceConfigureArgs([...base, '--voz', 'V', '--idioma', 'es', '--velocidad', 'texto-secreto']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('secreto');
  });
});

async function mundo(db: Db, o: { admin?: boolean; perfil?: boolean } = {}) {
  const clienteId = asClienteId((await createCliente(db)).id);
  const admin = await createUsuario(db, { email: `admin-${uniqueSuffix()}@example.test` });
  if (o.admin !== false) await assignRole(db, { usuarioId: admin.id, rolCodigo: 'administrador_novaciel' });
  if (o.perfil !== false) await createPerfilMarca(db, { clienteId, voz: { trato: 'tú', adjetivos: ['cercana'] }, identidad: { nombre: 'Cliente ficticio' } });
  return { clienteId, admin };
}

const args = (m: Awaited<ReturnType<typeof mundo>>, extra: Partial<Parameters<typeof configureVoice>[1]> = {}): Parameters<typeof configureVoice>[1] => ({
  clienteId: m.clienteId,
  adminEmail: m.admin.email,
  desactivar: false,
  vozId: 'VozFicticia1',
  idioma: 'es',
  ...extra,
});

describe('configureVoice', () => {
  it('writes voz.locucion as a NEW profile version made by the administrator, keeping the rest of the profile', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      const antes = (await getCurrentPerfilMarca(db, m.clienteId))!;
      const r = await configureVoice(db, args(m, { velocidad: 1.1 }));
      expect(r).toMatchObject({ changed: true, version: antes.version + 1 });
      const ahora = (await getCurrentPerfilMarca(db, m.clienteId))!;
      expect(ahora.id).toBe(r.perfilId);
      expect(ahora.voz).toMatchObject({ trato: 'tú', adjetivos: ['cercana'] });
      expect(ahora.identidad).toEqual(antes.identidad);
      expect(vozDelCliente(ahora.voz)).toEqual({
        vozId: 'VozFicticia1',
        ajustes: { estabilidad: 0.5, similitud: 0.75, estilo: 0, velocidad: 1.1, refuerzoVoz: true, idioma: 'es' },
      });
      const audit = (await db.query(`SELECT actor_usuario_id, accion FROM auditoria WHERE tabla = 'perfil_marca' AND fila_id = $1`, [r.perfilId])).rows;
      expect(audit).toEqual([{ actor_usuario_id: m.admin.id, accion: 'crear_version' }]);
      expect((await db.query('SELECT count(*)::int AS n FROM perfil_marca WHERE cliente_id = $1 AND es_actual', [m.clienteId])).rows[0].n).toBe(1);
    });
  });

  it('the same setting twice makes no second version', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      const primera = await configureVoice(db, args(m));
      const segunda = await configureVoice(db, args(m));
      expect(segunda).toEqual({ changed: false, perfilId: primera.perfilId, version: primera.version });
      expect((await db.query('SELECT count(*)::int AS n FROM perfil_marca WHERE cliente_id = $1', [m.clienteId])).rows[0].n).toBe(2);
      // A different setting does make one.
      expect((await configureVoice(db, args(m, { vozId: 'OtraVoz' }))).changed).toBe(true);
    });
  });

  it('--desactivar turns the voice off, keeping its settings, and needs a voice to turn off', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      await expect(configureVoice(db, { clienteId: m.clienteId, adminEmail: m.admin.email, desactivar: true })).rejects.toThrow(/no voice configured/);
      await configureVoice(db, args(m, { velocidad: 1.1 }));
      const r = await configureVoice(db, { clienteId: m.clienteId, adminEmail: m.admin.email, desactivar: true });
      expect(r.changed).toBe(true);
      const perfil = (await getCurrentPerfilMarca(db, m.clienteId))!;
      expect(vozDelCliente(perfil.voz)).toBeNull();
      expect((perfil.voz as { locucion: { habilitada: boolean; voice_id: string; velocidad: number } }).locucion).toMatchObject({ habilitada: false, voice_id: 'VozFicticia1', velocidad: 1.1 });
      // Turning it off twice changes nothing.
      expect((await configureVoice(db, { clienteId: m.clienteId, adminEmail: m.admin.email, desactivar: true })).changed).toBe(false);
    });
  });

  it('refuses an invalid setting by field name, and writes nothing', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      for (const [extra, campo] of [[{ idioma: 'ESP' }, 'idioma'], [{ vozId: 'a/b' }, 'voice_id'], [{ velocidad: 9 }, 'velocidad'], [{ estabilidad: 2 }, 'estabilidad']] as const) {
        const e = await configureVoice(db, args(m, extra)).catch((x: unknown) => x);
        expect(e, campo).toBeInstanceOf(ConfiguracionVozInvalidaError);
        expect((e as ConfiguracionVozInvalidaError).campos).toContain(campo);
      }
      expect((await db.query('SELECT count(*)::int AS n FROM perfil_marca WHERE cliente_id = $1', [m.clienteId])).rows[0].n).toBe(1);
    });
  });

  it('only an active NovaCiel administrator can do it; the client must have a profile', async () => {
    await withTestTransaction(async (db) => {
      const sinRol = await mundo(db, { admin: false });
      await expect(configureVoice(db, args(sinRol))).rejects.toThrow(/not an active NovaCiel administrator/);
      await expect(configureVoice(db, { ...args(sinRol), adminEmail: 'nadie@example.test' })).rejects.toThrow(/not an active NovaCiel administrator/);
      const sinPerfil = await mundo(db, { perfil: false });
      await expect(configureVoice(db, args(sinPerfil))).rejects.toThrow(/no brand profile/);
    });
  });

  it("isolation: configuring one client's voice does not touch another client's profile", async () => {
    await withTestTransaction(async (db) => {
      const a = await mundo(db);
      const b = await mundo(db);
      const antesB = (await getCurrentPerfilMarca(db, b.clienteId))!;
      await configureVoice(db, args(a));
      expect((await getCurrentPerfilMarca(db, b.clienteId))!.id).toBe(antesB.id);
      expect(vozDelCliente((await getCurrentPerfilMarca(db, b.clienteId))!.voz)).toBeNull();
    });
  });
});
