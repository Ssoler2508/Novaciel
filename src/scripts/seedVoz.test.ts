import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { vozDelCliente } from '../modules/locuciones/configuracionVoz.js';
import { createNewVersion, getCurrentPerfilMarca } from '../modules/perfilMarca/perfilMarcaRepository.js';
import { unitCost } from '../modules/precios/costEstimation.js';
import { asClienteId } from '../modules/shared/clienteId.js';
import { seedDevelopment, SEED_CLIENT_NAME, SEED_PRICE_NOTE, SEED_VOICE_PRICE_MODEL, SEED_VOICE_PRICE_PROVIDER } from './seedDevelopment.js';
import { SEED_LOCUCION } from './seedProfile.js';

const clienteDelSemillero = async (db: Parameters<Parameters<typeof withTestTransaction>[0]>[0]) =>
  asClienteId((await db.query('SELECT id FROM clientes WHERE nombre_comercial = $1', [SEED_CLIENT_NAME])).rows[0].id);

describe('seed: the fictional voice (Step 7d)', () => {
  it('a fresh database gets a fake price in characters and the voice in the FIRST profile version', async () => {
    await withTestTransaction(async (db) => {
      const first = await seedDevelopment(db);
      expect(first.created).toContain(`precio ficticio ${SEED_VOICE_PRICE_PROVIDER}/${SEED_VOICE_PRICE_MODEL} (caracteres)`);
      const prices = (await db.query(`SELECT unidad, nota, precio_por_bloque::text AS precio, tamano_bloque::text AS bloque FROM precios_modelos WHERE proveedor = $1`, [SEED_VOICE_PRICE_PROVIDER])).rows;
      expect(prices).toEqual([{ unidad: 'caracteres', nota: SEED_PRICE_NOTE, precio: '0.080000', bloque: '1000' }]);
      // Usable: 25 characters cost USD 0.002.
      await expect(unitCost(db, { provider: SEED_VOICE_PRICE_PROVIDER, model: SEED_VOICE_PRICE_MODEL, unit: 'caracteres', units: 25 })).resolves.toBe(2000n);

      const perfil = (await getCurrentPerfilMarca(db, await clienteDelSemillero(db)))!;
      expect(perfil.version).toBe(1);
      expect((perfil.voz as { locucion: unknown }).locucion).toEqual(SEED_LOCUCION);
      expect(vozDelCliente(perfil.voz)).toMatchObject({ vozId: SEED_LOCUCION.voice_id, ajustes: { idioma: 'es' } });
    });
  });

  it('is idempotent: a second run writes no rows, no audit rows and no new profile version', async () => {
    await withTestTransaction(async (db) => {
      await seedDevelopment(db);
      const auditoria = Number((await db.query('SELECT count(*) AS n FROM auditoria')).rows[0].n);
      const second = await seedDevelopment(db);
      expect(second.created).toEqual([]);
      expect(Number((await db.query('SELECT count(*) AS n FROM auditoria')).rows[0].n)).toBe(auditoria);
      expect((await db.query('SELECT count(*)::int AS n FROM perfil_marca')).rows[0].n).toBe(1);
      expect((await db.query(`SELECT count(*)::int AS n FROM precios_modelos WHERE proveedor = $1`, [SEED_VOICE_PRICE_PROVIDER])).rows[0].n).toBe(1);
    });
  });

  it('an already-seeded database WITHOUT a voice is NOT given a new profile version (voice:configure sets it)', async () => {
    await withTestTransaction(async (db) => {
      await seedDevelopment(db);
      const clienteId = await clienteDelSemillero(db);
      const perfil = (await getCurrentPerfilMarca(db, clienteId))!;
      // The profile as an older seed left it: the same, with no voice-over setting.
      const { locucion: _quitada, ...vozSinLocucion } = perfil.voz as Record<string, unknown>;
      await createNewVersion(db, clienteId, { creadoPor: perfil.creado_por, voz: vozSinLocucion });
      const versiones = Number((await db.query('SELECT count(*) AS n FROM perfil_marca WHERE cliente_id = $1', [clienteId])).rows[0].n);

      const again = await seedDevelopment(db);
      expect(again.created).toEqual([]);
      expect(Number((await db.query('SELECT count(*) AS n FROM perfil_marca WHERE cliente_id = $1', [clienteId])).rows[0].n)).toBe(versiones);
      const actual = (await getCurrentPerfilMarca(db, clienteId))!;
      expect((actual.voz as Record<string, unknown>)['locucion']).toBeUndefined();
      expect(vozDelCliente(actual.voz)).toBeNull();
    });
  });

  it('an already-seeded database with a voice edited by hand keeps it', async () => {
    await withTestTransaction(async (db) => {
      await seedDevelopment(db);
      const clienteId = await clienteDelSemillero(db);
      const perfil = (await getCurrentPerfilMarca(db, clienteId))!;
      await createNewVersion(db, clienteId, { creadoPor: perfil.creado_por, voz: { ...(perfil.voz as Record<string, unknown>), locucion: { habilitada: true, voice_id: 'VozEditada', idioma: 'en' } } });
      await seedDevelopment(db);
      expect(vozDelCliente((await getCurrentPerfilMarca(db, clienteId))!.voz)?.vozId).toBe('VozEditada');
    });
  });
});
