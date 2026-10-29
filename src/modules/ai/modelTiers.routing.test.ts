import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { createCliente, createMedia, createPrecioModelo, createTope } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeAlertSink, FakeLLMProvider } from '../../lib/ai/index.js';
import { PURPOSE_TIER, PURPOSES, type Purpose } from '../../lib/ai/modelTiers.js';
import { FakeVisionProvider } from '../../lib/ai/vision/fakeVisionProvider.js';
import { describeMedia } from '../media/describeMedia.js';
import { PriceNotFoundError } from '../precios/preciosRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import { generateStructured } from './generateStructured.js';

// Tier routing with fictional model ids. No network, no key.
const HEAVY = 'modelo-pesado-test';
const LIGHT = 'modelo-ligero-test';
const MODELS = { heavy: HEAVY, light: LIGHT };
const SISTEMA = { tipo: 'sistema' } as const;
const schema = z.object({ ok: z.boolean() });
const prompt = { system: 'Return JSON.', user: 'Reply {"ok": true}' };

async function world(db: Db, priced: { heavy?: boolean; light?: boolean } = { heavy: true, light: true }) {
  const clienteId = asClienteId((await createCliente(db)).id);
  await createTope(db, { clienteId, montoTecho: '10' });
  for (const [proveedor, tier, model] of [
    ['fake', 'heavy', HEAVY],
    ['fake', 'light', LIGHT],
    ['fake_vision', 'light', LIGHT],
  ] as const) {
    if (!priced[tier]) continue;
    const exists = await db.query('SELECT 1 FROM precios_modelos WHERE proveedor = $1 AND modelo = $2', [proveedor, model]);
    if (exists.rows.length === 0) await createPrecioModelo(db, { proveedor, modelo: model, precioEntrada: '1', precioSalida: '2' });
  }
  return { clienteId };
}

const ledger = async (db: Db, clienteId: string) =>
  (await db.query('SELECT proposito, modelo FROM libro_gastos WHERE cliente_id = $1 ORDER BY id', [clienteId])).rows;

describe('model tier routing', () => {
  const textPurposes = PURPOSES.filter((p) => p !== 'describe_media');

  it.each(textPurposes)('%s calls the model of its tier and the ledger records it', async (purpose: Purpose) => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await world(db);
      const provider = new FakeLLMProvider({ models: MODELS }).enqueue('{"ok": true}');
      await generateStructured(
        { db, provider, alerts: new FakeAlertSink() },
        { clienteId, purpose, schema, prompt, maxOutputTokens: 100, actor: SISTEMA },
      );
      const expected = PURPOSE_TIER[purpose] === 'heavy' ? HEAVY : LIGHT;
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]!.tier).toBe(PURPOSE_TIER[purpose]);
      expect(await ledger(db, clienteId)).toEqual([{ proposito: purpose, modelo: expected }]);
    });
  });

  it('describe_media uses the vision adapter with the light tier and records the light model', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await world(db);
      const media = await createMedia(db, { clienteId });
      const vision = new FakeVisionProvider({ models: MODELS }).enqueue({ description: 'Una fachada.', tags: ['fachada'] });
      await describeMedia({ db, vision, alerts: new FakeAlertSink() }, clienteId, media.id, SISTEMA);
      expect(vision.calls).toHaveLength(1);
      expect(vision.calls[0]!.tier).toBe('light');
      expect(await ledger(db, clienteId)).toEqual([{ proposito: 'describe_media', modelo: LIGHT }]);
    });
  });

  it('refuses a light-tier call whose model has no price, with 0 provider calls and no spend', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await world(db, { heavy: true, light: false });
      const provider = new FakeLLMProvider({ models: MODELS }).enqueue('{"ok": true}');
      await expect(
        generateStructured(
          { db, provider, alerts: new FakeAlertSink() },
          { clienteId, purpose: 'smoke_test_ligero', schema, prompt, maxOutputTokens: 100, actor: SISTEMA },
        ),
      ).rejects.toThrow(PriceNotFoundError);
      expect(provider.calls).toHaveLength(0);
      expect(await ledger(db, clienteId)).toEqual([]);
      expect((await db.query('SELECT 1 FROM autorizaciones_gasto WHERE cliente_id = $1', [clienteId])).rows).toHaveLength(0);

      // The heavy tier is priced, so it still works.
      await generateStructured(
        { db, provider, alerts: new FakeAlertSink() },
        { clienteId, purpose: 'smoke_test_pesado', schema, prompt, maxOutputTokens: 100, actor: SISTEMA },
      );
      expect(provider.calls).toHaveLength(1);
    });
  });

  it('refuses describe_media when the light model has no price, with 0 vision calls', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await world(db, { heavy: true, light: false });
      const media = await createMedia(db, { clienteId });
      const vision = new FakeVisionProvider({ models: MODELS }).enqueue({ description: 'Una fachada.', tags: [] });
      await expect(describeMedia({ db, vision, alerts: new FakeAlertSink() }, clienteId, media.id, SISTEMA)).rejects.toThrow(PriceNotFoundError);
      expect(vision.calls).toHaveLength(0);
      expect(await ledger(db, clienteId)).toEqual([]);
    });
  });
});
