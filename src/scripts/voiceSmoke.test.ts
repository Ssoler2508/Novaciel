import { describe, expect, it } from 'vitest';
import { createCliente, createPerfilMarca, createPrecioModelo, createTope } from '../../tests/utils/factories/index.js';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import type { Db } from '../db/types.js';
import { FakeVoiceProvider } from '../lib/ai/voice/fakeVoiceProvider.js';
import { VoiceProviderError } from '../lib/ai/voice/types.js';
import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';
import { parseVoiceSmokeArgs } from './voiceSmokeArgs.js';
import { formatVoiceSmokeReport, runVoiceSmoke, SMOKE_VOICE_TEXT, VoiceSmokeError } from './voiceSmokeCore.js';
import { assertVoiceSmokeAllowed, confirmVoiceSmokeDatabase } from './voiceSmokeGuard.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('parseVoiceSmokeArgs', () => {
  it('needs the client, takes an optional voice, in both syntaxes', () => {
    expect(parseVoiceSmokeArgs(['--cliente', ID])).toEqual({ clienteId: ID });
    expect(parseVoiceSmokeArgs([`--cliente=${ID}`, '--voz=Voz_1-a'])).toEqual({ clienteId: ID, vozId: 'Voz_1-a' });
  });

  it('refuses anything else, without echoing values', () => {
    for (const argv of [[], ['--cliente', 'no-es-uuid'], ['--cliente', ID, '--voz', 'a/b'], ['--cliente', ID, '--voz', 'x'.repeat(65)], ['--cliente', ID, '--texto', 'hola'], ['--cliente', ID, 'suelto'], ['--cliente', ID, '--cliente', ID], ['--cliente']]) {
      expect(() => parseVoiceSmokeArgs(argv), JSON.stringify(argv)).toThrow();
    }
    let message = '';
    try {
      parseVoiceSmokeArgs(['--cliente', ID, '--voz', 'ruta/secreta']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('secreta');
  });
});

describe('assertVoiceSmokeAllowed', () => {
  const ok = { nodeEnv: 'development', databaseUrl: 'postgresql://u:p@localhost:5432/novaciel_db', voiceProvider: 'elevenlabs', hasApiKey: true };

  it('allows only the real provider with a key, in a development database', () => {
    expect(assertVoiceSmokeAllowed(ok)).toBe('novaciel_db');
  });

  it('refuses the fake and the none providers, a missing key, production and test databases', () => {
    expect(() => assertVoiceSmokeAllowed({ ...ok, voiceProvider: 'fake' })).toThrow(/VOICE_PROVIDER=elevenlabs/);
    expect(() => assertVoiceSmokeAllowed({ ...ok, voiceProvider: 'none' })).toThrow(/VOICE_PROVIDER=elevenlabs/);
    expect(() => assertVoiceSmokeAllowed({ ...ok, hasApiKey: false })).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => assertVoiceSmokeAllowed({ ...ok, nodeEnv: 'production' })).toThrow(/production/);
    expect(() => assertVoiceSmokeAllowed({ ...ok, databaseUrl: 'postgresql://u:p@localhost:5432/novaciel_test' })).toThrow(/test database/);
  });

  it('never repeats the URL or a key in its messages', () => {
    for (const params of [{ ...ok, voiceProvider: 'fake' }, { ...ok, hasApiKey: false }, { ...ok, nodeEnv: 'production' }]) {
      try {
        assertVoiceSmokeAllowed({ ...params, databaseUrl: 'postgresql://usuario:clave-secreta@localhost:5432/novaciel_db' });
      } catch (error) {
        expect((error as Error).message).not.toMatch(/clave-secreta|usuario/);
      }
    }
  });

  it('confirms the connected database is not a test one', async () => {
    await expect(confirmVoiceSmokeDatabase({ query: async () => ({ rows: [{ name: 'novaciel_db' }] }) as never })).resolves.toBe('novaciel_db');
    await expect(confirmVoiceSmokeDatabase({ query: async () => ({ rows: [{ name: 'x_test' }] }) as never })).rejects.toThrow(/test database/);
  });
});

interface Mundo {
  clienteId: ClienteId;
  voice: FakeVoiceProvider;
}

async function mundo(db: Db, o: { locucion?: Record<string, unknown>; precio?: boolean; presupuesto?: boolean } = {}): Promise<Mundo> {
  const clienteId = asClienteId((await createCliente(db)).id);
  await createPerfilMarca(db, { clienteId, ...(o.locucion ? { voz: { locucion: o.locucion } } : {}) });
  if (o.presupuesto !== false) await createTope(db, { clienteId, montoTecho: '10' });
  if (o.precio !== false) await createPrecioModelo(db, { proveedor: 'fake_voice', modelo: 'fake-tts-model', unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });
  return { clienteId, voice: new FakeVoiceProvider() };
}

const medida = async () => 1500;
const filas = async (db: Db, clienteId: string) => (await db.query('SELECT unidad, unidades_entrada, unidades_salida, costo_real::text AS costo, proposito, resultado FROM libro_gastos WHERE cliente_id = $1', [clienteId])).rows;

describe('runVoiceSmoke', () => {
  it('makes ONE call with the given voice, pays in characters and reports only the five facts', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, voice } = await mundo(db);
      const report = await runVoiceSmoke({ db, provider: voice, measureAudio: medida, clienteId, vozId: 'VozDePrueba1' });
      expect(voice.calls).toHaveLength(1);
      expect(voice.calls[0]).toMatchObject({ text: SMOKE_VOICE_TEXT, voiceId: 'VozDePrueba1', purpose: 'smoke_test_voz' });
      expect(report).toEqual({ model: 'fake-tts-model', vozId: 'VozDePrueba1', caracteres: 25, duracionMs: 1500, cost: 2000n });
      expect(await filas(db, clienteId)).toEqual([{ unidad: 'caracteres', unidades_entrada: '25', unidades_salida: '0', costo: '0.002000', proposito: 'smoke_test_voz', resultado: 'ok' }]);
      // Nothing is stored: no voice-over record.
      expect((await db.query('SELECT 1 FROM locuciones WHERE cliente_id = $1', [clienteId])).rows).toEqual([]);
      expect(formatVoiceSmokeReport(report)).toEqual(['model: fake-tts-model', 'voice: VozDePrueba1', 'characters: 25', 'duration: 1.50 s', 'cost: USD 0.002000']);
    });
  });

  it('takes the voice and settings of the client when --voz is not given, and --voz wins when it is', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, voice } = await mundo(db, { locucion: { habilitada: true, voice_id: 'VozDelCliente', idioma: 'es', velocidad: 1.1 } });
      expect((await runVoiceSmoke({ db, provider: voice, measureAudio: medida, clienteId })).vozId).toBe('VozDelCliente');
      expect(voice.calls[0]!.settings.speed).toBe(1.1);
      expect((await runVoiceSmoke({ db, provider: voice, measureAudio: medida, clienteId, vozId: 'Otra' })).vozId).toBe('Otra');
    });
  });

  it('without any voice it refuses before spending', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, voice } = await mundo(db);
      await expect(runVoiceSmoke({ db, provider: voice, measureAudio: medida, clienteId })).rejects.toThrow(/no voice configured/);
      expect(voice.calls).toHaveLength(0);
      expect(await filas(db, clienteId)).toEqual([]);
    });
  });

  it('without a price in characters or without budget: refused, zero calls, nothing written', async () => {
    await withTestTransaction(async (db) => {
      const sinPrecio = await mundo(db, { precio: false });
      await expect(runVoiceSmoke({ db, provider: sinPrecio.voice, measureAudio: medida, clienteId: sinPrecio.clienteId, vozId: 'V' })).rejects.toThrow(/no price in characters/);
      expect(sinPrecio.voice.calls).toHaveLength(0);
    });
    await withTestTransaction(async (db) => {
      const sinPresupuesto = await mundo(db, { presupuesto: false });
      await expect(runVoiceSmoke({ db, provider: sinPresupuesto.voice, measureAudio: medida, clienteId: sinPresupuesto.clienteId, vozId: 'V' })).rejects.toThrow(/budget refused/);
      expect(sinPresupuesto.voice.calls).toHaveLength(0);
      expect(await filas(db, sinPresupuesto.clienteId)).toEqual([]);
    });
  });

  it('a provider failure releases the reservation; a time-out settles the estimate; the message has the category only', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, voice } = await mundo(db);
      voice.enqueue({ error: new VoiceProviderError('quota', 402, 'req_1', 'cuota') });
      const error = await runVoiceSmoke({ db, provider: voice, measureAudio: medida, clienteId, vozId: 'V' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VoiceSmokeError);
      expect((error as Error).message).toBe('provider error: quota (status 402) [cuota]');
      expect(await filas(db, clienteId)).toEqual([]);
      expect((await db.query('SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1', [clienteId])).rows).toEqual([{ estado: 'liberada' }]);

      voice.enqueue({ error: new VoiceProviderError('timeout') });
      await expect(runVoiceSmoke({ db, provider: voice, measureAudio: medida, clienteId, vozId: 'V' })).rejects.toThrow(/timeout/);
      expect(await filas(db, clienteId)).toEqual([{ unidad: 'caracteres', unidades_entrada: '25', unidades_salida: '0', costo: '0.002000', proposito: 'smoke_test_voz', resultado: 'error' }]);
    });
  });

  it('audio that cannot be measured is still paid and says so, without a path or a stack', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, voice } = await mundo(db);
      const error = await runVoiceSmoke({ db, provider: voice, measureAudio: async () => { throw new Error('C:\\secreto\\ffprobe'); }, clienteId, vozId: 'V' }).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/generated and paid/);
      expect((error as Error).message).not.toContain('secreto');
      expect(await filas(db, clienteId)).toHaveLength(1);
    });
  });
});
