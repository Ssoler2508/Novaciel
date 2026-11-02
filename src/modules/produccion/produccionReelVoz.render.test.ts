import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { describeFfmpeg } from '../../../tests/utils/ffmpeg.js';
import { solidClip } from '../../../tests/utils/ffmpegClips.js';
import { createCliente, createPrecioModelo, createTope } from '../../../tests/utils/factories/index.js';
import { producibleWorld, type ProducibleWorld, type WorldClip } from '../../../tests/utils/produccionWorld.js';
import { describeRemotion, navegadorDeLasPruebas } from '../../../tests/utils/remotion.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { runInTransaction } from '../../db/transaction.js';
import type { Db } from '../../db/types.js';
import { FakeVoiceProvider } from '../../lib/ai/voice/fakeVoiceProvider.js';
import { createLogger } from '../../lib/logger/index.js';
import { inspectMp4, probeVideo } from '../../lib/media/ffmpeg/index.js';
import { createAudioMeter } from '../../lib/media/ffmpeg/measureAudio.js';
import { medirSonoridad } from '../../lib/media/ffmpeg/medirSonoridad.js';
import { runFfmpeg } from '../../lib/media/ffmpeg/runFfmpeg.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { SEED_PROFILE } from '../../scripts/seedProfile.js';
import { ejecutarQC, type QcDeps } from '../controlCalidad/ejecutarQC.js';
import { getBriefActual } from '../directorCreativo/guionesRepository.js';
import { alineacionAPalabras } from '../locuciones/alineacion.js';
import { LocucionMasLargaQueEscenaError } from '../locuciones/errors.js';
import { getLocucion, listEscenasConVoz } from '../locuciones/locucionesRepository.js';
import { getPieza } from '../piezas/index.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { FakeCapaTextoAnimado, type EntradaCapa } from './capaTexto.js';
import type { PropsPlantilla } from './propsPlantilla.js';
import { crearCapaTextoRemotion } from './remotionCapaTexto.js';
import { getProduccionActual, type ProduccionView } from './produccionRepository.js';
import { producirPieza, type ProduccionDeps, type ReelRuntime } from './produccionService.js';
import { renderReel, type ReelRenderDeps } from './reelRenderer.js';
import { reelSceneMs } from './reelTimeline.js';
import { verifyReelOutput } from './reelVerify.js';
import { juzgarSonoridad } from './sonoridadVoz.js';
import { prepararVozDelReel, VozEscenaInvalidaError } from './vozReel.js';

// Step 7d, checkpoint D: a reel with a synthetic voice-over, with the REAL FFmpeg and ffprobe. Each scenario is rendered
// ONCE in beforeAll (committed through the pool); every case that must fail is a COPY of that file changed with FFmpeg,
// and the tests run in transactions that are rolled back, as in Step 8. The text layer is the fake one (transparent
// frames) except in the Remotion block at the end, which proves the pixels. Named *.render.test.ts: `npm run test:fast`
// skips it.

const SISTEMA = { tipo: 'sistema' } as const;
const FAST = { preset: 'veryfast' } as const;
const FPS = 30;
const LOCUCION = { habilitada: true, voice_id: 'VozFicticia1', idioma: 'es' };
const TEXTOS_EN_PANTALLA = ['Primera pantalla del reel', 'Segunda pantalla del reel', 'Tercera pantalla del reel'];
const VOCES = ['Tostamos granos frescos cada manana', undefined, 'Pasa por tu cafe de la casa'];

/** The same clean-copy flags the renderer uses, so a copy carries none of the tags that FFmpeg adds on its own. */
const LIMPIO = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-metadata:s:v:0', 'encoder='] as const;

let raiz: string;
let tempRoot: string;
let clip: WorldClip;
let llamadasFfmpeg = 0;

interface Escenario {
  clienteId: ClienteId;
  piezaId: string;
  world: ProducibleWorld;
  produccion: ProduccionView;
  bytes: Buffer;
  archivo: string;
  capa: FakeCapaTextoAnimado;
  voice: FakeVoiceProvider;
  logs: string[];
}
let A: Escenario & { v1: ProduccionView; llamadasTrasV1: number };
let B: Escenario; // the client has no voice configured
let E: Escenario; // a voice is configured but no template can be used (Remotion off)

function runtime(capa: FakeCapaTextoAnimado, licencia: 'gratuita' | null): ReelRuntime {
  return {
    tooling: async () => ({ version: 'test', hdr: true }),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ffmpegTimeoutMs: 180_000,
    ffprobeTimeoutMs: 15_000,
    tempRoot,
    outputSpec: FAST,
    runFfmpeg: async (args, options) => {
      llamadasFfmpeg += 1;
      return runFfmpeg(args, options);
    },
    remotion: { licencia: licencia ?? undefined, capaTexto: capa },
  };
}

function depsDe(w: ProducibleWorld, capa: FakeCapaTextoAnimado, voice: FakeVoiceProvider, logs: string[], licencia: 'gratuita' | null = 'gratuita'): ProduccionDeps {
  return {
    db: getTestPool(),
    storage: w.storage,
    logger: createLogger('debug', { write: (l: string) => void logs.push(l) }),
    reel: runtime(capa, licencia),
    voz: { provider: voice, measureAudio: createAudioMeter({ ffprobePath: 'ffprobe', timeoutMs: 15_000 }) },
  };
}

async function escenario(opciones: { perfilVoz: Record<string, unknown>; licencia?: 'gratuita' | null; voces?: (string | undefined)[] }): Promise<Escenario> {
  const pool = getTestPool();
  const w = await runInTransaction(pool, (tx) =>
    producibleWorld(tx, { formato: 'reel', clips: [clip], sceneSeconds: 5, sinCifras: true, texts: TEXTOS_EN_PANTALLA, vocesEnOff: opciones.voces ?? VOCES, perfilVoz: opciones.perfilVoz }),
  );
  await createTope(pool, { clienteId: w.clienteId, montoTecho: '10' });
  const capa = new FakeCapaTextoAnimado();
  const voice = new FakeVoiceProvider();
  const logs: string[] = [];
  const deps = depsDe(w, capa, voice, logs, opciones.licencia === undefined ? 'gratuita' : opciones.licencia);
  const { produccion } = await producirPieza(deps, w.clienteId, w.piezaId, SISTEMA);
  const bytes = await w.storage.get(produccion.archivos[0]!.clave_almacenamiento);
  const archivo = path.join(raiz, `${w.piezaId}.mp4`);
  await writeFile(archivo, bytes);
  return { clienteId: w.clienteId, piezaId: w.piezaId, world: w, produccion, bytes, archivo, capa, voice, logs };
}

beforeAll(async () => {
  raiz = await mkdtemp(path.join(os.tmpdir(), 'novaciel voz ñá '));
  tempRoot = path.join(raiz, 'trabajo');
  await mkdir(tempRoot, { recursive: true });
  const dir = path.join(raiz, 'clips');
  await mkdir(dir, { recursive: true });
  clip = { bytes: await readFile(solidClip(dir, 'ok.mp4', '3366cc')), ancho: 720, alto: 1280, duracionMs: 6000 };

  await cleanupDomainTables(getTestPool());
  await createPrecioModelo(getTestPool(), { proveedor: 'fake_voice', modelo: 'fake-tts-model', unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });

  // Scenario A: a voiced reel, produced twice (the second production must come from the cache).
  const a = await escenario({ perfilVoz: { locucion: LOCUCION } });
  const llamadasTrasV1 = a.voice.calls.length;
  const v2 = await producirPieza(depsDe(a.world, a.capa, a.voice, a.logs), a.clienteId, a.piezaId, SISTEMA, { reproducir: true });
  const bytes2 = await a.world.storage.get(v2.produccion.archivos[0]!.clave_almacenamiento);
  await writeFile(a.archivo, bytes2);
  A = { ...a, v1: a.produccion, produccion: v2.produccion, bytes: bytes2, llamadasTrasV1 };

  // Scenario B: the same brief, a client with no voice configured. Scenario E: a voice, but Remotion is off.
  B = await escenario({ perfilVoz: {} });
  E = await escenario({ perfilVoz: { locucion: LOCUCION }, licencia: null });
}, 600_000);

afterAll(async () => {
  await cleanupDomainTables(getTestPool());
  await closeTestPool();
  await rm(raiz, { recursive: true, force: true });
});

/** The words (and their times) of a layer the fake text layer was asked for. */
const palabrasDeCapa = (c: EntradaCapa) => (c.props as PropsPlantilla).lineas.flatMap((l) => l.palabras);

const meter = { ffmpegPath: 'ffmpeg', timeoutMs: 60_000 };
const por = (checks: { codigo: string }[], codigo: string) => checks.find((c) => c.codigo === codigo) as { codigo: string; resultado: string; severidad: string; parametros: Record<string, unknown> } | undefined;

/** Quality control of a scenario's current production, in a transaction that is rolled back, with the given bytes in storage. */
async function controlar(e: Escenario, bytes: Buffer = e.bytes) {
  return withTestTransaction(async (db) => {
    const storage = new FakeStorage();
    await storage.put(e.produccion.archivos[0]!.clave_almacenamiento, bytes);
    const deps: QcDeps = { db, storage, tempRoot, reel: { ffprobePath: 'ffprobe', ffprobeTimeoutMs: 15_000, ffmpegPath: 'ffmpeg', ffmpegTimeoutMs: 120_000 } };
    return ejecutarQC(deps, e.clienteId, e.piezaId, SISTEMA);
  });
}

/** A copy of the good reel with its audio changed and everything else copied. */
function copiaConAudio(e: Escenario, nombre: string, filtro: string): string {
  const salida = path.join(raiz, nombre);
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', e.archivo, '-c:v', 'copy', '-af', filtro, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', ...LIMPIO, '-movflags', '+faststart', salida], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not make the audio copy: ${r.stderr.slice(0, 300)}`);
  return salida;
}

/** Loudness of a stretch of the reel's audio. */
async function tramo(archivo: string, desde: number, duracion: number): Promise<number> {
  const salida = path.join(raiz, `tramo-${desde}-${duracion}-${Date.now()}.wav`);
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(desde), '-t', String(duracion), '-i', archivo, '-vn', '-ar', '48000', '-ac', '2', salida], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not cut a stretch of audio');
  return (await medirSonoridad(salida, meter)).integradaLufs;
}

const count = async (tabla: string, clienteId: string) => Number((await getTestPool().query(`SELECT count(*) AS n FROM ${tabla} WHERE cliente_id = $1`, [clienteId])).rows[0].n);

describeFfmpeg('scenario A: a reel with a voice-over', () => {
  it('records the voice-overs the production used, the template and the audit, and nothing else about the voice', async () => {
    const pool = getTestPool();
    const links = (await pool.query('SELECT escena, locucion_id FROM producciones_locuciones WHERE produccion_id = $1 ORDER BY escena', [A.produccion.id])).rows;
    expect(links.map((l) => l.escena)).toEqual([1, 3]);
    expect(A.produccion.plantilla).not.toBeNull();
    const audit = (await pool.query(`SELECT datos_despues FROM auditoria WHERE tabla = 'producciones' AND accion = 'crear' AND fila_id = $1`, [A.produccion.id])).rows[0].datos_despues;
    expect(audit).toMatchObject({ voces: 2, escenas: 3 });
    expect(audit.voz_omitida).toBeUndefined();
    expect(JSON.stringify(audit)).not.toMatch(/granos|Tostamos|Primera/);
    expect(await listEscenasConVoz(pool, A.clienteId, A.produccion.id)).toEqual([1, 3]);
  });

  it('draws the SPOKEN text with the voice\'s real times in the voiced scenes, and the on-screen text only in the others', async () => {
    const pool = getTestPool();
    const brief = (await getBriefActual(pool, A.clienteId, A.piezaId))!;
    const [capa1, capa2, capa3] = A.capa.llamadas;
    const palabras = (c: EntradaCapa | undefined) => palabrasDeCapa(c!);
    expect(palabras(capa1).map((p) => p.texto)).toEqual(VOCES[0]!.split(' '));
    expect(palabras(capa2).map((p) => p.texto)).toEqual(TEXTOS_EN_PANTALLA[1]!.split(' '));
    expect(palabras(capa3).map((p) => p.texto)).toEqual(VOCES[2]!.split(' '));
    expect(JSON.stringify(A.capa.llamadas.slice(0, 3))).not.toContain('Primera');
    expect(JSON.stringify(A.capa.llamadas.slice(0, 3))).not.toContain('Tercera');

    // The times are exactly those of the stored alignment of the voice-over.
    const link = (await pool.query('SELECT locucion_id FROM producciones_locuciones WHERE produccion_id = $1 AND escena = 1', [A.produccion.id])).rows[0];
    const locucion = (await getLocucion(pool, A.clienteId, link.locucion_id))!;
    const esperados = alineacionAPalabras(locucion.alineacion, VOCES[0]!, reelSceneMs(brief.contenido.escenas[0]!.duracion_s!), 150);
    const modo = (capa1!.props as PropsPlantilla).modo;
    // Word-by-word templates show each word at its spoken time; block and title templates show the whole text when the first word is spoken.
    expect(palabras(capa1).map((p) => p.inicioMs)).toEqual(modo === 'palabras' ? esperados.map((p) => p.inicioMs) : esperados.map(() => esperados[0]!.inicioMs));
    expect(palabras(capa1)[0]!.inicioMs).toBe(150);
  });

  it('the stored MP4 passes the verifier: one video and one AAC 48 kHz stereo audio stream, the tag allow-list, no metadata boxes', async () => {
    const facts = await probeVideo(A.archivo, { ffprobePath: 'ffprobe', timeoutMs: 15_000 });
    const layout = await inspectMp4(A.archivo);
    expect(() => verifyReelOutput({ facts, layout, timeline: { totalFrames: 450, totalMs: 15_000 }, tamanoBytes: A.bytes.length })).not.toThrow();
    expect(facts.audio).toMatchObject({ codec: 'aac', sampleRate: 48_000, channels: 2 });
    expect(Math.abs(facts.audio!.duracionMs! - facts.video!.duracionMs!)).toBeLessThanOrEqual(100);
  });

  it('the audio is audible and inside the loudness range', async () => {
    const medida = await medirSonoridad(A.archivo, meter);
    expect(juzgarSonoridad(medida)).toBe('en_rango');
    expect(Math.abs(medida.integradaLufs + 16)).toBeLessThanOrEqual(2);
    expect(medida.picoVerdaderoDbtp === null || medida.picoVerdaderoDbtp <= -0.5).toBe(true);
  });

  it('the voice is where it belongs: audible in the voiced scenes, silence in the scene without a voice', async () => {
    expect(await tramo(A.archivo, 0.4, 2)).toBeGreaterThan(-45); // scene 1
    expect(await tramo(A.archivo, 5.3, 4.4)).toBeLessThanOrEqual(-69); // scene 2: nothing
    expect(await tramo(A.archivo, 10.4, 2)).toBeGreaterThan(-45); // scene 3
  });

  it('quality control passes; the synthetic audio is a WARNING for the reviewer; the spoken text is checked as voz_en_off', async () => {
    const { revision } = await controlar(A);
    expect(revision.resultado).toBe('aprobado');
    expect(revision.codigos_fallo).toEqual([]);
    for (const codigo of ['voz_audio_ausente', 'voz_volumen_fuera_de_rango', 'voz_subtitulos_ausentes', 'voz_omitida_sin_plantilla', 'cifra_libre', 'regla_prohibida_palabra']) {
      expect(por(revision.checks, codigo), codigo).toMatchObject({ resultado: 'pasa' });
    }
    expect(por(revision.checks, 'voz_etiqueta_ia_pendiente')).toMatchObject({ resultado: 'advertencia', severidad: 'advertencia', parametros: { escenas: [1, 3] } });
    expect(JSON.stringify(revision.checks)).not.toMatch(/Tostamos|granos|Primera/);
  });

  it('voz_audio_ausente: a copy of the reel with silent audio', async () => {
    const copia = copiaConAudio(A, 'silencio.mp4', 'volume=0');
    const { revision } = await controlar(A, await readFile(copia));
    expect(revision.codigos_fallo).toContain('voz_audio_ausente');
    expect(por(revision.checks, 'voz_audio_ausente')).toMatchObject({ resultado: 'no_pasa', parametros: { ordenes: [1] } });
    expect(revision.codigos_fallo).not.toContain('reel_formato'); // the copy is a valid reel: only its sound is wrong
  });

  it('voz_volumen_fuera_de_rango: copies that are too quiet and too loud', async () => {
    for (const [nombre, filtro] of [['bajo.mp4', 'volume=-12dB'], ['alto.mp4', 'volume=10dB']] as const) {
      const { revision } = await controlar(A, await readFile(copiaConAudio(A, nombre, filtro)));
      expect(revision.codigos_fallo, nombre).toContain('voz_volumen_fuera_de_rango');
      const check = por(revision.checks, 'voz_volumen_fuera_de_rango')!;
      expect(check.resultado).toBe('no_pasa');
      expect(check.parametros).toMatchObject({ ordenes: [1], objetivo_lufs: -16, tolerancia_lu: 2, pico_maximo_dbtp: -0.5 });
      expect(JSON.stringify(check)).not.toMatch(/[A-Za-z]{15,}/);
    }
  });

  it('voz_subtitulos_ausentes: the production records no template while it has a voice (only the row changes)', async () => {
    const { revision } = await withTestTransaction(async (db) => {
      const storage = new FakeStorage();
      await storage.put(A.produccion.archivos[0]!.clave_almacenamiento, A.bytes);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE producciones DISABLE TRIGGER producciones_before_update_delete');
      await db.query('SET CONSTRAINTS ALL DEFERRED');
      await db.query('UPDATE producciones SET plantilla = NULL, plantilla_version = NULL WHERE id = $1', [A.produccion.id]);
      return ejecutarQC({ db, storage, tempRoot, reel: { ffprobePath: 'ffprobe', ffprobeTimeoutMs: 15_000, ffmpegPath: 'ffmpeg', ffmpegTimeoutMs: 120_000 } }, A.clienteId, A.piezaId, SISTEMA);
    });
    expect(revision.codigos_fallo).toContain('voz_subtitulos_ausentes');
  });

  it('a spoken figure that is not a fact is caught by the same rule-2 check (cifra_libre at voz_en_off:N)', async () => {
    const { revision } = await withTestTransaction(async (db) => {
      const storage = new FakeStorage();
      await storage.put(A.produccion.archivos[0]!.clave_almacenamiento, A.bytes);
      // Both texts of the brief are altered (the rendered one and the model's), as a bad brief would have them.
      const row = (await db.query('SELECT id, contenido, contenido_modelo FROM guiones WHERE id = $1', [A.produccion.guion_id])).rows[0];
      const tocar = (c: { escenas: { voz_en_off?: string }[] }) => ({ ...c, escenas: c.escenas.map((e, i) => (i === 2 ? { ...e, voz_en_off: 'Solo cuesta cuatro dolares hoy' } : e)) });
      await db.query('ALTER TABLE guiones DISABLE TRIGGER USER');
      await db.query('UPDATE guiones SET contenido = $2::jsonb, contenido_modelo = $3::jsonb WHERE id = $1', [row.id, JSON.stringify(tocar(row.contenido)), JSON.stringify(tocar(row.contenido_modelo ?? row.contenido))]);
      return ejecutarQC({ db, storage, tempRoot, reel: { ffprobePath: 'ffprobe', ffprobeTimeoutMs: 15_000, ffmpegPath: 'ffmpeg', ffmpegTimeoutMs: 120_000 } }, A.clienteId, A.piezaId, SISTEMA);
    });
    expect(revision.codigos_fallo).toContain('cifra_libre');
    expect(por(revision.checks, 'cifra_libre')!.parametros).toMatchObject({ campos: ['voz_en_off:2'] });
  });

  it('the second production came from the cache: the same voice-overs, zero provider calls, zero new spend', async () => {
    const pool = getTestPool();
    expect(A.produccion.version).toBe(2);
    expect(A.voice.calls).toHaveLength(A.llamadasTrasV1);
    expect(A.voice.calls).toHaveLength(2);
    const v1 = (await pool.query('SELECT locucion_id FROM producciones_locuciones WHERE produccion_id = $1 ORDER BY escena', [A.v1.id])).rows;
    const v2 = (await pool.query('SELECT locucion_id FROM producciones_locuciones WHERE produccion_id = $1 ORDER BY escena', [A.produccion.id])).rows;
    expect(v2).toEqual(v1);
    expect(await count('locuciones', A.clienteId)).toBe(2);
    expect(await count('libro_gastos', A.clienteId)).toBe(2);
    const gasto = (await pool.query(`SELECT unidad, resultado FROM libro_gastos WHERE cliente_id = $1`, [A.clienteId])).rows;
    expect(gasto).toEqual([{ unidad: 'caracteres', resultado: 'ok' }, { unidad: 'caracteres', resultado: 'ok' }]);
  });

  it('isolation: another client sees nothing of the voice-overs or their links', async () => {
    const pool = getTestPool();
    const otro = asClienteId((await createCliente(pool)).id);
    expect(await listEscenasConVoz(pool, otro, A.produccion.id)).toEqual([]);
    expect((await pool.query('SELECT 1 FROM locuciones WHERE cliente_id = $1', [otro])).rows).toEqual([]);
    expect((await pool.query('SELECT 1 FROM producciones_locuciones WHERE cliente_id = $1', [otro])).rows).toEqual([]);
    expect(await getProduccionActual(pool, otro, A.piezaId)).toBeNull();
  });

  it('the logs hold counts, ids and numbers: never the spoken text, the on-screen text or the temp path', async () => {
    const logs = A.logs.join('\n');
    expect(logs).toContain('reel voice-over ready');
    expect(logs).toContain('reel rendered');
    for (const prohibido of ['Tostamos', 'granos', 'Pasa por', 'Primera pantalla', 'Segunda pantalla', 'novaciel-reel', 'ñá', tempRoot, 'VozFicticia1']) {
      expect(logs.includes(prohibido), prohibido).toBe(false);
    }
    expect(await readdir(tempRoot)).toEqual([]);
  });
});

describeFfmpeg('scenario B: a client with no voice configured', () => {
  it('gets the silent track of Step 7b, the on-screen text in every scene, no voice-over records and no provider call', async () => {
    expect(B.voice.calls).toHaveLength(0);
    expect(await count('locuciones', B.clienteId)).toBe(0);
    expect(await count('producciones_locuciones', B.clienteId)).toBe(0);
    expect(await count('libro_gastos', B.clienteId)).toBe(0);
    const palabras = B.capa.llamadas.slice(0, 3).map((c) => palabrasDeCapa(c).map((p) => p.texto).join(' '));
    expect(palabras).toEqual(TEXTOS_EN_PANTALLA);
    const medida = await medirSonoridad(B.archivo, meter);
    expect(juzgarSonoridad(medida)).toBe('silencio');
    const facts = await probeVideo(B.archivo, { ffprobePath: 'ffprobe', timeoutMs: 15_000 });
    const layout = await inspectMp4(B.archivo);
    expect(() => verifyReelOutput({ facts, layout, timeline: { totalFrames: 450, totalMs: 15_000 }, tamanoBytes: B.bytes.length })).not.toThrow();
    const audit = (await getTestPool().query(`SELECT datos_despues FROM auditoria WHERE tabla = 'producciones' AND accion = 'crear' AND fila_id = $1`, [B.produccion.id])).rows[0].datos_despues;
    expect(audit).toMatchObject({ voz_omitida: 'sin_configuracion' });
    expect(audit.voces).toBeUndefined();
  });

  it('passes quality control with no voice finding of any kind', async () => {
    const { revision } = await controlar(B);
    expect(revision.resultado).toBe('aprobado');
    for (const codigo of ['voz_audio_ausente', 'voz_volumen_fuera_de_rango', 'voz_subtitulos_ausentes', 'voz_etiqueta_ia_pendiente', 'voz_omitida_sin_plantilla']) {
      expect(por(revision.checks, codigo), codigo).toMatchObject({ resultado: 'pasa' });
    }
    expect(revision.checks.filter((c) => c.resultado === 'advertencia')).toEqual([]);
  });
});

describeFfmpeg('scenario E: a voice is configured but no template can be used', () => {
  it('omits the voice, keeps the 7b overlays and records why', async () => {
    expect(E.voice.calls).toHaveLength(0);
    expect(E.capa.llamadas).toEqual([]); // no template: the PNG overlays
    expect(E.produccion.plantilla).toBeNull();
    expect(await count('producciones_locuciones', E.clienteId)).toBe(0);
    expect(juzgarSonoridad(await medirSonoridad(E.archivo, meter))).toBe('silencio');
    const audit = (await getTestPool().query(`SELECT datos_despues FROM auditoria WHERE tabla = 'producciones' AND accion = 'crear' AND fila_id = $1`, [E.produccion.id])).rows[0].datos_despues;
    expect(audit).toMatchObject({ voz_omitida: 'sin_plantilla' });
  });

  it('quality control passes and shows the reviewer the WARNING voz_omitida_sin_plantilla', async () => {
    const { revision } = await controlar(E);
    expect(revision.resultado).toBe('aprobado');
    expect(por(revision.checks, 'voz_omitida_sin_plantilla')).toMatchObject({ resultado: 'advertencia', severidad: 'advertencia' });
    for (const codigo of ['voz_audio_ausente', 'voz_volumen_fuera_de_rango', 'voz_subtitulos_ausentes', 'voz_etiqueta_ia_pendiente']) {
      expect(por(revision.checks, codigo), codigo).toMatchObject({ resultado: 'pasa' });
    }
  });
});

describeFfmpeg('refusals before anything is rendered', () => {
  async function mundo(db: Db, voces: (string | undefined)[], voice: FakeVoiceProvider) {
    const w = await producibleWorld(db, { formato: 'reel', clips: [clip], sceneSeconds: 5, sinCifras: true, vocesEnOff: voces, perfilVoz: { locucion: LOCUCION } });
    await createTope(db, { clienteId: w.clienteId, montoTecho: '10' });
    await createPrecioModelo(db, { proveedor: 'fake_voice', modelo: 'fake-tts-model', unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });
    const capa = new FakeCapaTextoAnimado();
    const logs: string[] = [];
    const deps: ProduccionDeps = { ...depsDe(w, capa, voice, logs), db };
    return { w, capa, deps };
  }

  async function nadaProducido(db: Db, w: ProducibleWorld, antes: number, capa: FakeCapaTextoAnimado) {
    expect(llamadasFfmpeg).toBe(antes); // FFmpeg never ran
    expect(capa.llamadas).toEqual([]);
    expect(w.storage.keys().filter((k) => k.includes('/producidos/'))).toEqual([]);
    expect((await db.query('SELECT 1 FROM producciones WHERE cliente_id = $1', [w.clienteId])).rows).toEqual([]);
    expect((await getPieza(db, w.clienteId, w.piezaId, { includeDescartados: true }))!.estado).toBe('guion_listo');
    expect(await readdir(tempRoot)).toEqual([]);
  }

  it('a voice too long for its scene, found once measured: typed refusal, FFmpeg never runs, the voice stays cached', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider({ msPerChar: 100 });
      const { w, capa, deps } = await mundo(db, ['Cada manana tostamos cafe de origen y lo servimos con calma', undefined, undefined], voice);
      const antes = llamadasFfmpeg;
      const error = await producirPieza(deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LocucionMasLargaQueEscenaError);
      expect((error as LocucionMasLargaQueEscenaError).escenas.map((e) => e.escena)).toEqual([1]);
      await nadaProducido(db, w, antes, capa);
      expect(voice.calls).toHaveLength(1);
      expect((await db.query('SELECT 1 FROM locuciones WHERE cliente_id = $1', [w.clienteId])).rows).toHaveLength(1);
    });
  }, 120_000);

  it('a text that cannot be spoken (a figure that is not a fact): no provider call, FFmpeg never runs', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider();
      const { w, capa, deps } = await mundo(db, ['El cafe cuesta cuatro dolares', undefined, undefined], voice);
      const antes = llamadasFfmpeg;
      const error = await producirPieza(deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VozEscenaInvalidaError);
      expect(voice.calls).toHaveLength(0);
      expect((await db.query('SELECT 1 FROM autorizaciones_gasto WHERE cliente_id = $1', [w.clienteId])).rows).toEqual([]);
      await nadaProducido(db, w, antes, capa);
    });
  }, 120_000);

  it('the lower bound: even the fastest speech does not fit, nothing is paid and FFmpeg never runs', async () => {
    await withTestTransaction(async (db) => {
      const voice = new FakeVoiceProvider();
      const { w, capa, deps } = await mundo(db, ['palabra '.repeat(30).trim(), undefined, undefined], voice);
      const antes = llamadasFfmpeg;
      const error = await producirPieza(deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LocucionMasLargaQueEscenaError);
      expect(voice.calls).toHaveLength(0);
      expect((await db.query('SELECT 1 FROM autorizaciones_gasto WHERE cliente_id = $1', [w.clienteId])).rows).toEqual([]);
      await nadaProducido(db, w, antes, capa);
    });
  }, 120_000);
});

// ---- The pixels: the words of the subtitles appear at the times of the voice (real Remotion) ----------------------

async function oscurosEnFotograma(video: string, n: number, carpeta: string): Promise<number> {
  const salida = path.join(carpeta, `f-${n}.png`);
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', salida], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not sample a frame');
  const { data } = await sharp(salida).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let oscuros = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i]! < 100 && data[i + 1]! < 100 && data[i + 2]! < 100) oscuros++;
  return oscuros;
}

describeFfmpeg('the subtitles follow the voice (real FFmpeg and real Remotion)', () => {
  describeRemotion('words appear at the times of the voice', () => {
    it('the dark text of the scene grows at each SPOKEN word and not before (frame samples of the final MP4)', async () => {
      await withTestTransaction(async (db) => {
        const texto = 'Tostamos granos frescos cada manana temprano';
        const voice = new FakeVoiceProvider();
        const w = await producibleWorld(db, {
          formato: 'reel',
          clips: [clip],
          sceneSeconds: 5,
          sinCifras: true,
          texts: ['TEXTO-EN-PANTALLA-QUE-NO-SE-DIBUJA', '', ''],
          vocesEnOff: [texto, undefined, undefined],
          perfilVoz: { locucion: LOCUCION },
        });
        await createTope(db, { clienteId: w.clienteId, montoTecho: '10' });
        await createPrecioModelo(db, { proveedor: 'fake_voice', modelo: 'fake-tts-model', unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });
        const brief = (await getBriefActual(db, w.clienteId, w.piezaId))!;
        const voz = await prepararVozDelReel({
          db,
          storage: w.storage,
          voz: { provider: voice, measureAudio: createAudioMeter({ ffprobePath: 'ffprobe', timeoutMs: 15_000 }) },
          logger: createLogger('silent'),
          clienteId: w.clienteId,
          brief,
          piezaId: w.piezaId,
          instantePieza: new Date('2026-11-05T15:00:00Z'),
          perfilVoz: { locucion: LOCUCION },
          hayPlantilla: true,
          actor: SISTEMA,
          ahora: new Date('2026-11-02T12:00:00Z'),
        });
        expect(voz.voces).toHaveLength(1);
        const tiempos = voz.voces[0]!.tiempos;
        expect(tiempos).toHaveLength(6);

        const rows = (await db.query('SELECT id, clave_almacenamiento FROM media WHERE cliente_id = $1', [w.clienteId])).rows as { id: string; clave_almacenamiento: string }[];
        const deps: ReelRenderDeps = {
          storage: w.storage,
          tooling: async () => ({ version: 'test', hdr: true }),
          ffmpegPath: 'ffmpeg',
          ffprobePath: 'ffprobe',
          ffmpegTimeoutMs: 180_000,
          ffprobeTimeoutMs: 15_000,
          tempRoot,
          capaTexto: crearCapaTextoRemotion({ licencia: 'gratuita', navegador: navegadorDeLasPruebas() }),
          capaTimeoutMs: 120_000,
        };
        const muestras = await renderReel(
          deps,
          {
            guion: brief,
            fuentes: Object.fromEntries(rows.map((m) => [m.id, m.clave_almacenamiento])),
            kitVisual: SEED_PROFILE.kit_visual,
            plantilla: { id: 'palabra_a_palabra', version: 1 },
            voces: voz.voces,
            outputSpec: FAST,
          },
          async (reel) => {
            expect(reel.voz).toMatchObject({ escenas: [1] });
            expect(juzgarSonoridad({ integradaLufs: reel.voz!.finalLufs, picoVerdaderoDbtp: reel.voz!.picoVerdaderoDbtp })).toBe('en_rango');
            const carpeta = path.join(tempRoot, `muestras-${Date.now()}`);
            await mkdir(carpeta, { recursive: true });
            const salida: { antes: number; despues: number }[] = [];
            for (const t of tiempos) {
              const inicioFotograma = Math.min(149, Math.round((t.inicioMs * FPS) / 1000));
              salida.push({ antes: await oscurosEnFotograma(reel.ruta, Math.max(0, inicioFotograma - 1), carpeta), despues: await oscurosEnFotograma(reel.ruta, Math.min(149, inicioFotograma + 8), carpeta) });
            }
            await rm(carpeta, { recursive: true, force: true });
            return salida;
          },
        );

        expect(muestras[0]!.antes).toBe(0); // nothing of the text before the first spoken word
        for (const [i, m] of muestras.entries()) {
          expect(m.despues, `word ${i} shows up at its spoken time`).toBeGreaterThan(m.antes);
          if (i > 0) expect(m.antes, `word ${i} is not early`).toBeLessThanOrEqual(muestras[i - 1]!.despues * 1.05 + 20);
        }
        expect(await readdir(tempRoot)).toEqual([]);
      });
    }, 300_000);
  });
});
