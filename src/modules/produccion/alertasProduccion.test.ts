import { describe, expect, it } from 'vitest';
import { createCliente, createPrecioModelo, createTope, createUsuarioConRol } from '../../../tests/utils/factories/index.js';
import { producibleWorld } from '../../../tests/utils/produccionWorld.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { FakeVoiceProvider } from '../../lib/ai/voice/fakeVoiceProvider.js';
import { VoiceProviderError, type VoiceErrorKind } from '../../lib/ai/voice/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeNotifier } from '../../lib/notificaciones/notifiers.js';
import { runPieceProduce } from '../../scripts/pieceProduceCore.js';
import type { AlertasRuntime } from '../alertas/raiseAlert.js';
import { asClienteId } from '../shared/clienteId.js';
import { alertarFalloDeProduccion } from './alertasProduccion.js';
import { FakeCapaTextoAnimado } from './capaTexto.js';
import { CapaTextoError, RemotionNoDisponibleError, TextDoesNotFitError } from './errors.js';
import { ejecutarJobProducirPieza } from './produccionJobs.js';
import { producirPieza, type ProduccionDeps, type ReelRuntime } from './produccionService.js';

// voz_fallo and capa_texto_fallo raised from the production itself (Step 11, checkpoint C): the voice provider or the
// text engine failed while producing a reel. The failure happens BEFORE any FFmpeg run, so nothing here needs FFmpeg:
// the source probe is a stub and the text layer is the fake. The alerts from quality control are in alertasTriggers.test.ts.

const SISTEMA = { tipo: 'sistema' } as const;
const SECRETO = 'SECRETO-DEL-CLIENTE-4471';
const CLIP = { bytes: Buffer.from('clip'), ancho: 720, alto: 1280, duracionMs: 6000 };
const LOCUCION = { habilitada: true, voice_id: 'VozFicticia1', idioma: 'es' };
const VOCES = ['Cada manana tostamos cafe de origen', undefined, 'Pasa por tu cafe de la casa'];

function alertasDe(db: Db, notifier = new FakeNotifier()): AlertasRuntime {
  return { db, notifier, umbrales: [50, 80, 100], logger: createLogger('silent') };
}

function runtime(capa: FakeCapaTextoAnimado): ReelRuntime {
  return {
    tooling: async () => ({ version: 'test', hdr: false }),
    ffmpegPath: 'ffmpeg-no-existe',
    ffprobePath: 'ffprobe-no-existe',
    ffmpegTimeoutMs: 1000,
    ffprobeTimeoutMs: 1000,
    // The probe of the source clip is a stub: what the file "really" holds is not under test here.
    probeVideo: async () =>
      ({ duracionMs: 6000, video: { ancho: 720, alto: 1280, duracionMs: 6000, fps: 30, hdr: false } }) as never,
    runFfmpeg: async () => {
      throw new Error('FFmpeg must not run');
    },
    remotion: { licencia: 'gratuita', capaTexto: capa },
  };
}

async function mundo(db: Db, opciones: { voz: boolean; voice?: FakeVoiceProvider; capa?: FakeCapaTextoAnimado }) {
  const w = await producibleWorld(db, {
    formato: 'reel',
    clips: [CLIP],
    sceneSeconds: 5,
    sinCifras: true,
    vocesEnOff: opciones.voz ? VOCES : [],
    perfilVoz: opciones.voz ? { locucion: LOCUCION } : {},
  });
  await createTope(db, { clienteId: w.clienteId, montoTecho: '10' });
  await createPrecioModelo(db, { proveedor: 'fake_voice', modelo: 'fake-tts-model', unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });
  const voice = opciones.voice ?? new FakeVoiceProvider();
  const capa = opciones.capa ?? new FakeCapaTextoAnimado();
  const notifier = new FakeNotifier();
  const staff = await createUsuarioConRol(db, 'operador_novaciel');
  const deps: ProduccionDeps = {
    db,
    storage: w.storage,
    logger: createLogger('silent'),
    reel: runtime(capa),
    voz: { provider: voice, measureAudio: async () => 1000 },
    alertas: alertasDe(db, notifier),
  };
  return { w, deps, voice, capa, notifier, staff };
}

const filas = async (db: Db, clienteId: string) =>
  (await db.query<{ codigo: string; severidad: string; parametros: Record<string, unknown>; clave_dedupe: string }>(
    'SELECT codigo, severidad, parametros, clave_dedupe FROM alertas WHERE cliente_id = $1 ORDER BY codigo, clave_dedupe',
    [clienteId],
  )).rows;

describe('voz_fallo from the production', () => {
  it('a voice provider failure while producing raises ONE critical alert with the kind of the error, and the error still reaches the caller', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider().enqueue({ error: new VoiceProviderError('quota', 402, 'req_1', 'cuota') });
      const m = await mundo(db, { voz: true, voice });
      const error = await producirPieza(m.deps, m.w.clienteId, m.w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VoiceProviderError);
      const rows = await filas(db, m.w.clienteId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ codigo: 'voz_fallo', severidad: 'critica', parametros: { pieza_id: m.w.piezaId, tipo: 'quota' } });
      expect(Object.keys(rows[0]!.parametros).sort()).toEqual(['intento_en', 'pieza_id', 'tipo']);
      expect(rows[0]!.clave_dedupe).toBe(`voz:intento:${m.w.piezaId}:${rows[0]!.parametros.intento_en}`);
      // NovaCiel is told, with the alert template and the alert id only.
      expect(m.notifier.enviados.map((e) => e.destinatarioUsuarioId)).toContain(m.staff.id);
      expect(m.notifier.enviados.every((e) => e.plantilla === 'alerta_novaciel' && e.referencia.tipo === 'alerta')).toBe(true);
      // The piece did not move and no production was stored.
      expect((await db.query('SELECT 1 FROM producciones WHERE pieza_id = $1', [m.w.piezaId])).rows).toHaveLength(0);
    });
  });

  it('the production job raises the same alert (one per attempt), whether it ends rejected or failed', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider().enqueue({ error: new VoiceProviderError('timeout') });
      const m = await mundo(db, { voz: true, voice });
      await ejecutarJobProducirPieza(m.deps, { clienteId: m.w.clienteId, piezaId: m.w.piezaId }, 'job').catch(() => undefined);
      const rows = await filas(db, m.w.clienteId);
      expect(rows.map((r) => [r.codigo, r.parametros.tipo])).toEqual([['voz_fallo', 'timeout']]);
    });
  });

  it('piece:produce raises it too, and its report lines hold no text of the client', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider().enqueue({ error: new VoiceProviderError('auth', 401, 'req_2') });
      const m = await mundo(db, { voz: true, voice });
      const result = await runPieceProduce(m.deps, { modo: 'pieza', clienteId: m.w.clienteId, piezaId: m.w.piezaId, reproducir: false });
      expect(result.ok).toBe(false);
      expect((await filas(db, m.w.clienteId)).map((r) => [r.codigo, r.parametros.tipo])).toEqual([['voz_fallo', 'auth']]);
      expect(result.lines.join('\n')).not.toContain('tostamos');
    });
  });

  it('a second failing attempt is a second alert; the same attempt reported twice is one', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider().enqueue({ error: new VoiceProviderError('server', 500) }, { error: new VoiceProviderError('server', 500) });
      const m = await mundo(db, { voz: true, voice });
      await producirPieza(m.deps, m.w.clienteId, m.w.piezaId, SISTEMA).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await producirPieza(m.deps, m.w.clienteId, m.w.piezaId, SISTEMA).catch(() => undefined);
      expect(await filas(db, m.w.clienteId)).toHaveLength(2);

      const clienteId = asClienteId(m.w.clienteId);
      const alertas = alertasDe(db);
      const instante = new Date('2026-11-03T12:00:00.000Z');
      await alertarFalloDeProduccion(alertas, clienteId, m.w.piezaId, instante, new VoiceProviderError('rate_limit'));
      await alertarFalloDeProduccion(alertas, clienteId, m.w.piezaId, instante, new VoiceProviderError('rate_limit'));
      expect(await filas(db, m.w.clienteId)).toHaveLength(3);
    });
  });

  it('every kind of voice error is accepted, and nothing but the kind is stored', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const clienteId = asClienteId(cliente.id);
      const piezaId = '33333333-3333-4333-8333-333333333333';
      const kinds: VoiceErrorKind[] = ['auth', 'quota', 'rate_limit', 'bad_request', 'server', 'timeout'];
      for (const [i, kind] of kinds.entries()) {
        await alertarFalloDeProduccion(alertasDe(db), clienteId, piezaId, new Date(Date.UTC(2026, 10, 3, 12, i)), new VoiceProviderError(kind, 500, 'req_9', `razon ${SECRETO}`));
      }
      const rows = await filas(db, cliente.id);
      expect(rows.map((r) => r.parametros.tipo).sort()).toEqual([...kinds].sort());
      expect(JSON.stringify(rows)).not.toContain(SECRETO);
      expect(JSON.stringify(rows)).not.toContain('req_9');
    });
  });
});

describe('capa_texto_fallo from the production', () => {
  it('a text-layer failure while rendering raises ONE alert with the reason code', async () => {
    await withTestTransaction(async (db) => {
      const capa = new FakeCapaTextoAnimado();
      capa.fallarCon = new CapaTextoError('fallo_de_render');
      const m = await mundo(db, { voz: false, capa });
      const error = await producirPieza(m.deps, m.w.clienteId, m.w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CapaTextoError);
      expect(capa.llamadas.length).toBeGreaterThan(0);
      const rows = await filas(db, m.w.clienteId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ codigo: 'capa_texto_fallo', severidad: 'critica', parametros: { pieza_id: m.w.piezaId, razon: 'fallo_de_render' } });
      expect(rows[0]!.clave_dedupe).toBe(`capa:intento:${m.w.piezaId}:${rows[0]!.parametros.intento_en}`);
    });
  });

  it('RemotionNoDisponibleError raises it with its reason, through the job and through piece:produce', async () => {
    await withTestTransaction(async (db) => {
      const capa = new FakeCapaTextoAnimado();
      capa.fallarCon = new RemotionNoDisponibleError('navegador_ausente');
      const m = await mundo(db, { voz: false, capa });
      await ejecutarJobProducirPieza(m.deps, { clienteId: m.w.clienteId, piezaId: m.w.piezaId }, 'job').catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await runPieceProduce(m.deps, { modo: 'pieza', clienteId: m.w.clienteId, piezaId: m.w.piezaId, reproducir: false });
      expect(result.ok).toBe(false);
      const rows = await filas(db, m.w.clienteId);
      expect(rows.map((r) => [r.codigo, r.parametros.razon])).toEqual([
        ['capa_texto_fallo', 'navegador_ausente'],
        ['capa_texto_fallo', 'navegador_ausente'],
      ]);
    });
  });

  it('every reason code of the text engine is accepted', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const clienteId = asClienteId(cliente.id);
      const piezaId = '44444444-4444-4444-8444-444444444444';
      const razones = ['entrada_invalida', 'fallo_de_bundle', 'fallo_de_render', 'tiempo_agotado', 'salida_incompleta', 'solicitud_externa'] as const;
      for (const [i, razon] of razones.entries()) {
        await alertarFalloDeProduccion(alertasDe(db), clienteId, piezaId, new Date(Date.UTC(2026, 10, 3, 12, i)), new CapaTextoError(razon));
      }
      await alertarFalloDeProduccion(alertasDe(db), clienteId, piezaId, new Date(Date.UTC(2026, 10, 3, 13, 0)), new RemotionNoDisponibleError('paquete_ausente'));
      const rows = await filas(db, cliente.id);
      expect(rows.map((r) => r.parametros.razon).sort()).toEqual([...razones, 'paquete_ausente'].sort());
    });
  });
});

describe('other failures and no wiring', () => {
  it('any other error raises nothing here, and without the alerts wired nothing happens', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const clienteId = asClienteId(cliente.id);
      const piezaId = '55555555-5555-4555-8555-555555555555';
      const alertas = alertasDe(db);
      await alertarFalloDeProduccion(alertas, clienteId, piezaId, new Date(), new TextDoesNotFitError('demasiadas_lineas'));
      await alertarFalloDeProduccion(alertas, clienteId, piezaId, new Date(), new Error(SECRETO));
      await alertarFalloDeProduccion(undefined, clienteId, piezaId, new Date(), new VoiceProviderError('quota'));
      expect(await filas(db, cliente.id)).toEqual([]);
    });
  });

  it('a failure of the production of another client never creates an alert for this one', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider().enqueue({ error: new VoiceProviderError('quota') });
      const m = await mundo(db, { voz: true, voice });
      const otro = await createCliente(db);
      await producirPieza(m.deps, m.w.clienteId, m.w.piezaId, SISTEMA).catch(() => undefined);
      expect(await filas(db, otro.id)).toEqual([]);
      expect(await filas(db, m.w.clienteId)).toHaveLength(1);
    });
  });
});
