import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { createGuion, createPrecioModelo, createTope } from '../../../tests/utils/factories/index.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { FakeVoiceProvider } from '../../lib/ai/voice/fakeVoiceProvider.js';
import type { SynthesisRequest, SynthesisResult } from '../../lib/ai/voice/types.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { asClienteId } from '../shared/clienteId.js';
import { generarLocucion, type GenerarLocucionRequest, type LocucionDeps } from './locucionService.js';

// Real, separate connections: this test commits, so it cleans up with cleanupDomainTables.

class Lenta extends FakeVoiceProvider {
  override async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    await new Promise((resolve) => setTimeout(resolve, 150)); // long enough for the callers to overlap
    return super.synthesize(request);
  }
}

describe('generarLocucion under concurrency', () => {
  beforeEach(async () => {
    await cleanupDomainTables(getTestPool());
  });
  afterAll(async () => {
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  it('several identical requests at once make ONE provider call and pay once', async () => {
    const pool = getTestPool();
    const guion = await createGuion(pool);
    const clienteId = asClienteId(guion.cliente_id);
    await createTope(pool, { clienteId, montoTecho: '10' });
    await createPrecioModelo(pool, { proveedor: 'fake_voice', modelo: 'fake-tts-model', unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });
    const voice = new Lenta();
    const deps: LocucionDeps = {
      db: pool,
      storage: new FakeStorage(),
      voice,
      measureAudio: async () => 1560,
    };
    const req: GenerarLocucionRequest = {
      clienteId,
      guionId: guion.id,
      escena: 1,
      texto: 'Hola mundo desde la casa',
      vozId: 'voz-ficticia',
      ajustes: { estabilidad: 0.5, similitud: 0.75, estilo: 0, velocidad: 1, refuerzoVoz: true, idioma: 'es' },
      actor: { tipo: 'sistema' },
    };

    const results = await Promise.all(Array.from({ length: 4 }, () => generarLocucion(deps, req)));

    expect(voice.calls).toHaveLength(1);
    expect(new Set(results.map((r) => r.locucion.id)).size).toBe(1);
    expect(results.filter((r) => !r.cacheHit)).toHaveLength(1);
    expect(Number((await pool.query('SELECT count(*) AS n FROM libro_gastos WHERE cliente_id = $1', [clienteId])).rows[0].n)).toBe(1);
    expect(Number((await pool.query('SELECT count(*) AS n FROM locuciones WHERE cliente_id = $1', [clienteId])).rows[0].n)).toBe(1);
    expect((await pool.query('SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1', [clienteId])).rows).toEqual([{ estado: 'liquidada' }]);
  });
});
