import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { createCliente, createGuion, createPrecioModelo, createTope } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeVoiceProvider } from '../../lib/ai/voice/fakeVoiceProvider.js';
import { VoiceProviderError, type SynthesisRequest, type SynthesisResult } from '../../lib/ai/voice/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { PriceNotFoundError } from '../precios/preciosRepository.js';
import { BudgetRefusedError } from '../presupuesto/presupuestoService.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import type { AjustesVoz } from './claveCache.js';
import { LocucionGuionNoEncontradoError, LocucionRespuestaInvalidaError } from './errors.js';
import { generarLocucion, type GenerarLocucionRequest, type LocucionDeps } from './locucionService.js';

const SISTEMA = { tipo: 'sistema' } as const;
const TEXTO = 'Hola mundo desde la casa'; // 24 characters
const COSTO_24 = 1920n; // 24 characters at USD 0.08 per 1000, in micro-USD
const AJUSTES: AjustesVoz = { estabilidad: 0.5, similitud: 0.75, estilo: 0, velocidad: 1, refuerzoVoz: true, idioma: 'es' };

/** Duration of the WAV the fake writes: 16 kHz, 16-bit mono. */
const mideWav = async (filePath: string): Promise<number> => {
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(filePath);
  return Math.round(((bytes.length - 44) / 32_000) * 1000);
};

interface World {
  clienteId: ClienteId;
  guionId: string;
  piezaId: string;
  voice: FakeVoiceProvider;
  storage: FakeStorage;
  deps: LocucionDeps;
  req: GenerarLocucionRequest;
}

async function world(db: Db, opts: { price?: boolean; budget?: boolean; voice?: FakeVoiceProvider; logger?: LocucionDeps['logger'] } = {}): Promise<World> {
  const guion = await createGuion(db);
  const clienteId = asClienteId(guion.cliente_id);
  if (opts.budget !== false) await createTope(db, { clienteId, montoTecho: '10' });
  const hayPrecio = (await db.query(`SELECT 1 FROM precios_modelos WHERE proveedor = 'fake_voice' AND modelo = 'fake-tts-model' AND unidad = 'caracteres'`)).rows.length > 0;
  if (opts.price !== false && !hayPrecio) {
    await createPrecioModelo(db, { proveedor: 'fake_voice', modelo: 'fake-tts-model', unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });
  }
  const voice = opts.voice ?? new FakeVoiceProvider();
  const storage = new FakeStorage();
  const deps: LocucionDeps = { db, storage, voice, measureAudio: mideWav, logger: opts.logger ?? createLogger('silent') };
  const req: GenerarLocucionRequest = { clienteId, guionId: guion.id, escena: 1, texto: TEXTO, vozId: 'voz-ficticia', ajustes: AJUSTES, actor: SISTEMA };
  return { clienteId, guionId: guion.id, piezaId: guion.pieza_id, voice, storage, deps, req };
}

async function count(db: Db, table: string, clienteId: string): Promise<number> {
  return Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE cliente_id = $1`, [clienteId])).rows[0].n);
}

describe('generarLocucion: a miss pays once', () => {
  it('estimates, authorizes, calls, stores the audio, records the voice-over and settles in characters', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const r = await generarLocucion(w.deps, w.req);

      expect(r.cacheHit).toBe(false);
      expect(r.costo).toBe(COSTO_24);
      expect(w.voice.calls).toHaveLength(1);
      expect(w.voice.calls[0]).toMatchObject({ text: TEXTO, voiceId: 'voz-ficticia', purpose: 'voz_en_off' });

      const l = r.locucion;
      expect(l).toMatchObject({ clienteId: w.clienteId, guionId: w.guionId, escena: 1, caracteres: 24, proveedor: 'fake_voice', modeloId: 'fake-tts-model', vozId: 'voz-ficticia', formato: 'wav_16000' });
      expect(l.claveCache).toMatch(/^[0-9a-f]{64}$/);
      expect(l.costoReal).toBe(COSTO_24);
      expect(l.duracionMs).toBe(24 * 65); // measured on the file
      expect(l.alineacion.caracteres.join('')).toBe(TEXTO);
      expect(l.alineacion.inicioMs[0]).toBe(0);

      // The storage key follows the convention <cliente_id>/locuciones/<clave_cache>.<ext>.
      expect(l.claveAlmacenamiento).toBe(`${w.clienteId}/locuciones/${l.claveCache}.wav`);
      expect(w.storage.has(l.claveAlmacenamiento)).toBe(true);

      const ledger = (await db.query('SELECT unidad, unidades_entrada, unidades_salida, costo_real::text AS costo, resultado, proposito, proveedor, modelo FROM libro_gastos WHERE cliente_id = $1', [w.clienteId])).rows;
      expect(ledger).toEqual([{ unidad: 'caracteres', unidades_entrada: '24', unidades_salida: '0', costo: '0.001920', resultado: 'ok', proposito: 'voz_en_off', proveedor: 'fake_voice', modelo: 'fake-tts-model' }]);
      const auth = (await db.query('SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1', [w.clienteId])).rows;
      expect(auth).toEqual([{ estado: 'liquidada' }]);
      const audit = (await db.query(`SELECT accion, datos_despues FROM auditoria WHERE tabla = 'locuciones' AND fila_id = $1`, [l.id])).rows;
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain('mundo');
    });
  });
});

describe('generarLocucion: the cache', () => {
  it('a second request with the same key makes zero calls and costs nothing', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const first = await generarLocucion(w.deps, w.req);
      const ledgerBefore = await count(db, 'libro_gastos', w.clienteId);
      const authsBefore = await count(db, 'autorizaciones_gasto', w.clienteId);

      const second = await generarLocucion(w.deps, w.req);
      expect(second.cacheHit).toBe(true);
      expect(second.costo).toBe(0n);
      expect(second.locucion.id).toBe(first.locucion.id);
      expect(w.voice.calls).toHaveLength(1);
      expect(await count(db, 'libro_gastos', w.clienteId)).toBe(ledgerBefore);
      expect(await count(db, 'autorizaciones_gasto', w.clienteId)).toBe(authsBefore);
      expect(await count(db, 'locuciones', w.clienteId)).toBe(1);
    });
  });

  it('works even when the price was removed or the budget is gone: a hit needs neither', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      await generarLocucion(w.deps, w.req);
      await db.query('UPDATE topes SET monto_techo = 0 WHERE cliente_id = $1', [w.clienteId]);
      await expect(generarLocucion(w.deps, w.req)).resolves.toMatchObject({ cacheHit: true });
    });
  });

  it('a request from another brief of the same client reuses the voice-over', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const first = await generarLocucion(w.deps, w.req);
      const otro = await createGuion(db, { piezaId: w.piezaId }); // the next version of the brief of the same piece
      const second = await generarLocucion(w.deps, { ...w.req, guionId: otro.id, escena: 3 });
      expect(second.cacheHit).toBe(true);
      expect(second.locucion.id).toBe(first.locucion.id);
      expect(w.voice.calls).toHaveLength(1);
    });
  });

  it('every input of the key makes a new voice-over: text, voice, settings', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      await generarLocucion(w.deps, w.req);
      await generarLocucion(w.deps, { ...w.req, texto: `${TEXTO}.` });
      await generarLocucion(w.deps, { ...w.req, vozId: 'otra-voz' });
      await generarLocucion(w.deps, { ...w.req, ajustes: { ...AJUSTES, velocidad: 1.1 } });
      expect(w.voice.calls).toHaveLength(4);
      expect(await count(db, 'locuciones', w.clienteId)).toBe(4);
    });
  });

  it("isolation: another client's identical request is its own call and its own row", async () => {
    await withTestTransaction(async (db) => {
      const a = await world(db);
      const otroGuion = await createGuion(db);
      const clienteB = asClienteId(otroGuion.cliente_id);
      await createTope(db, { clienteId: clienteB, montoTecho: '10' });
      const ra = await generarLocucion(a.deps, a.req);
      const rb = await generarLocucion(a.deps, { ...a.req, clienteId: clienteB, guionId: otroGuion.id });

      expect(rb.cacheHit).toBe(false);
      expect(a.voice.calls).toHaveLength(2);
      expect(rb.locucion.id).not.toBe(ra.locucion.id);
      expect(rb.locucion.claveCache).toBe(ra.locucion.claveCache);
      expect(rb.locucion.claveAlmacenamiento).toBe(`${clienteB}/locuciones/${rb.locucion.claveCache}.wav`);
      expect(rb.locucion.claveAlmacenamiento).not.toBe(ra.locucion.claveAlmacenamiento);
      expect(await count(db, 'locuciones', a.clienteId)).toBe(1);
      expect(await count(db, 'locuciones', clienteB)).toBe(1);
    });
  });
});

describe('generarLocucion: refused before anything leaves', () => {
  it('without a price in characters: zero calls, no reservation, no ledger row', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, { price: false });
      // A token price for the same model does not count.
      await createPrecioModelo(db, { proveedor: 'fake_voice', modelo: 'fake-tts-model' });
      await expect(generarLocucion(w.deps, w.req)).rejects.toBeInstanceOf(PriceNotFoundError);
      expect(w.voice.calls).toHaveLength(0);
      expect(await count(db, 'autorizaciones_gasto', w.clienteId)).toBe(0);
      expect(await count(db, 'libro_gastos', w.clienteId)).toBe(0);
      expect(await count(db, 'locuciones', w.clienteId)).toBe(0);
    });
  });

  it('without budget (no ceiling, ceiling too low, client switch off): zero calls', async () => {
    await withTestTransaction(async (db) => {
      const sinTecho = await world(db, { budget: false });
      await expect(generarLocucion(sinTecho.deps, sinTecho.req)).rejects.toBeInstanceOf(BudgetRefusedError);
      expect(sinTecho.voice.calls).toHaveLength(0);

      const bajo = await world(db, { budget: false });
      await createTope(db, { clienteId: bajo.clienteId, montoTecho: '0.001' });
      await expect(generarLocucion(bajo.deps, bajo.req)).rejects.toMatchObject({ reason: 'techo_superado' });
      expect(bajo.voice.calls).toHaveLength(0);

      const apagado = await world(db);
      await db.query(`INSERT INTO configuracion_gasto_cliente (cliente_id, gasto_habilitado) VALUES ($1, false)`, [apagado.clienteId]);
      await expect(generarLocucion(apagado.deps, apagado.req)).rejects.toMatchObject({ reason: 'interruptor_cliente' });
      expect(apagado.voice.calls).toHaveLength(0);
      expect(await count(db, 'libro_gastos', apagado.clienteId)).toBe(0);
    });
  });

  it("a brief of another client: zero calls, nothing reserved", async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const ajeno = await createGuion(db);
      await expect(generarLocucion(w.deps, { ...w.req, guionId: ajeno.id })).rejects.toBeInstanceOf(LocucionGuionNoEncontradoError);
      await expect(generarLocucion(w.deps, { ...w.req, guionId: '00000000-0000-4000-8000-000000000000' })).rejects.toBeInstanceOf(LocucionGuionNoEncontradoError);
      expect(w.voice.calls).toHaveLength(0);
      expect(await count(db, 'autorizaciones_gasto', w.clienteId)).toBe(0);
    });
  });
});

describe('generarLocucion: the budget after a failure', () => {
  it('a provider failure releases the reservation: no ledger row, no voice-over, and nothing is cached', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider();
      voice.enqueue({ error: new VoiceProviderError('server', 503, 'req_1') });
      const w = await world(db, { voice });
      await expect(generarLocucion(w.deps, w.req)).rejects.toMatchObject({ kind: 'server', status: 503 });
      expect((await db.query('SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1', [w.clienteId])).rows).toEqual([{ estado: 'liberada' }]);
      expect(await count(db, 'libro_gastos', w.clienteId)).toBe(0);
      expect(await count(db, 'locuciones', w.clienteId)).toBe(0);
      // A retry works and pays once.
      const again = await generarLocucion(w.deps, w.req);
      expect(again.cacheHit).toBe(false);
      expect(await count(db, 'libro_gastos', w.clienteId)).toBe(1);
    });
  });

  it('every non-timeout category releases', async () => {
    await withTestTransaction(async (db) => {
      for (const kind of ['auth', 'quota', 'rate_limit', 'bad_request', 'server'] as const) {
        const voice = new FakeVoiceProvider();
        voice.enqueue({ error: new VoiceProviderError(kind, 500) });
        const w = await world(db, { voice });
        await expect(generarLocucion(w.deps, w.req)).rejects.toMatchObject({ kind });
        expect((await db.query('SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1', [w.clienteId])).rows).toEqual([{ estado: 'liberada' }]);
      }
    });
  });

  it('a time-out settles the estimate as an error (the money may have been spent)', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider();
      voice.enqueue({ error: new VoiceProviderError('timeout') });
      const w = await world(db, { voice });
      await expect(generarLocucion(w.deps, w.req)).rejects.toMatchObject({ kind: 'timeout' });
      const ledger = (await db.query('SELECT unidad, unidades_entrada, costo_real::text AS costo, resultado FROM libro_gastos WHERE cliente_id = $1', [w.clienteId])).rows;
      expect(ledger).toEqual([{ unidad: 'caracteres', unidades_entrada: '24', costo: '0.001920', resultado: 'error' }]);
      expect((await db.query('SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1', [w.clienteId])).rows).toEqual([{ estado: 'liquidada' }]);
      expect(await count(db, 'locuciones', w.clienteId)).toBe(0);
    });
  });

  it('an alignment that does not match the text is paid (settled as schema_invalido), not stored and not cached', async () => {
    await withTestTransaction(async (db) => {
      class Torcida extends FakeVoiceProvider {
        override async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
          const r = await super.synthesize(request);
          return { ...r, alignment: { ...r.alignment, characters: [...'Otro texto distinto xx'] } };
        }
      }
      const w = await world(db, { voice: new Torcida() });
      await expect(generarLocucion(w.deps, w.req)).rejects.toMatchObject({ reason: 'alineacion_invalida' });
      await expect(generarLocucion(w.deps, w.req)).rejects.toBeInstanceOf(LocucionRespuestaInvalidaError);
      const ledger = (await db.query('SELECT resultado FROM libro_gastos WHERE cliente_id = $1', [w.clienteId])).rows;
      expect(ledger).toEqual([{ resultado: 'schema_invalido' }, { resultado: 'schema_invalido' }]);
      expect(await count(db, 'locuciones', w.clienteId)).toBe(0);
      expect(w.storage.keys()).toEqual([]);
    });
  });

  it('audio that cannot be measured is paid (settled as error) and not stored', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const deps: LocucionDeps = { ...w.deps, measureAudio: async () => { throw new Error('ffprobe failed'); } };
      await expect(generarLocucion(deps, w.req)).rejects.toMatchObject({ reason: 'audio_ilegible' });
      expect((await db.query('SELECT resultado FROM libro_gastos WHERE cliente_id = $1', [w.clienteId])).rows).toEqual([{ resultado: 'error' }]);
      expect(await count(db, 'locuciones', w.clienteId)).toBe(0);
      const cero: LocucionDeps = { ...w.deps, measureAudio: async () => 0 };
      await expect(generarLocucion(cero, { ...w.req, texto: 'Otro texto' })).rejects.toMatchObject({ reason: 'audio_ilegible' });
    });
  });

  it('a storage failure after the call settles the spend as an error and rethrows', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      class Roto extends FakeStorage {
        override async putFile(): Promise<void> {
          throw new Error('disk full');
        }
      }
      await expect(generarLocucion({ ...w.deps, storage: new Roto() }, w.req)).rejects.toThrow('disk full');
      expect((await db.query('SELECT resultado FROM libro_gastos WHERE cliente_id = $1', [w.clienteId])).rows).toEqual([{ resultado: 'error' }]);
      expect(await count(db, 'locuciones', w.clienteId)).toBe(0);
    });
  });
});

describe('generarLocucion: logs and errors without the text, the voice key or the provider reply', () => {
  function capture() {
    const lines: string[] = [];
    const destination = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    return { lines, logger: createLogger('debug', destination) };
  }

  it('success, provider failure, time-out and invalid alignment log only ids, counts, ms and cost', async () => {
    await withTestTransaction(async (db) => {
      const { lines, logger } = capture();
      const voice = new FakeVoiceProvider();
      voice.enqueue({ error: new VoiceProviderError('server', 500, 'req_9') }, { error: new VoiceProviderError('timeout') });
      const w = await world(db, { voice, logger });
      await expect(generarLocucion(w.deps, w.req)).rejects.toBeInstanceOf(VoiceProviderError);
      await expect(generarLocucion(w.deps, w.req)).rejects.toBeInstanceOf(VoiceProviderError);
      await generarLocucion(w.deps, w.req);
      await generarLocucion(w.deps, w.req);

      const all = lines.join('');
      expect(all).toContain('voice-over generated');
      expect(all).toContain('voice call failed');
      expect(all).toContain(w.clienteId);
      for (const secreto of ['Hola', 'mundo', 'casa', TEXTO, 'voz-ficticia']) expect(all, secreto).not.toContain(secreto);
    });
  });
});
