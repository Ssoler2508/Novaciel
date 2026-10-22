import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeFfmpeg } from '../../../tests/utils/ffmpeg.js';
import { solidClip } from '../../../tests/utils/ffmpegClips.js';
import { createCliente, createPerfilMarca, createPlanSemanal } from '../../../tests/utils/factories/index.js';
import { producibleWorld, type WorldClip } from '../../../tests/utils/produccionWorld.js';
import { describeRemotion, navegadorDeLasPruebas } from '../../../tests/utils/remotion.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { SEED_PROFILE } from '../../scripts/seedProfile.js';
import { getBriefActual } from '../directorCreativo/guionesRepository.js';
import { getPieza } from '../piezas/index.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { FakeCapaTextoAnimado } from './capaTexto.js';
import { elegirColores } from './colors.js';
import { CapaTextoError, RemotionNoDisponibleError, UnsupportedGlyphsError } from './errors.js';
import { crearMedidor } from './medidor.js';
import { elegirPlantilla } from './plantillas.js';
import { construirPropsPlantilla } from './propsPlantilla.js';
import { getProduccionActual } from './produccionRepository.js';
import { producirPieza, type ProduccionDeps, type ReelRuntime } from './produccionService.js';
import { renderReel, type ReelRenderDeps } from './reelRenderer.js';
import { crearCapaTextoRemotion } from './remotionCapaTexto.js';

// Step 7c, checkpoint D: templates in reel production, with the real FFmpeg (and, where it says so, the real
// Remotion). The FFmpeg-only tests use FakeCapaTextoAnimado (transparent frames) to prove the pipeline around
// the port; the Remotion one proves the pixels. Named *.render.test.ts: `npm run test:fast` skips them.

const SISTEMA = { tipo: 'sistema' } as const;
const SECRET = 'SECRETO-DE-PLANTILLA';
const FAST = { preset: 'veryfast' } as const;
const FPS = 30;

let root: string;
let tempRoot: string;
let clipOk: WorldClip;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'novaciel plantilla ñá '));
  tempRoot = path.join(root, 'trabajo');
  await mkdir(tempRoot, { recursive: true });
  const dir = path.join(root, 'clips');
  await mkdir(dir, { recursive: true });
  clipOk = { bytes: await readFile(solidClip(dir, 'ok.mp4', '3366cc')), ancho: 720, alto: 1280, duracionMs: 6000 };
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

class CountingStorage extends FakeStorage {
  downloads = 0;
  override async getFile(key: string, destPath: string): Promise<void> {
    this.downloads += 1;
    return super.getFile(key, destPath);
  }
}

interface World {
  db: Db;
  clienteId: ClienteId;
  piezaId: string;
  storage: CountingStorage;
  media: { id: string; clave_almacenamiento: string }[];
  logs: string[];
  deps: ProduccionDeps;
}

async function world(db: Db, remotion: ReelRuntime['remotion'], texts?: string[]): Promise<World> {
  const clienteId = asClienteId((await createCliente(db)).id);
  const perfilId = (await createPerfilMarca(db, { clienteId, kit_visual: structuredClone(SEED_PROFILE.kit_visual) })).id;
  const planId = (await createPlanSemanal(db, { clienteId, estado: 'aprobado', perfilMarcaId: perfilId })).id;
  const storage = new CountingStorage();
  const w = await producibleWorld(db, { formato: 'reel', clips: [clipOk], ...(texts ? { texts } : {}), base: { clienteId, planId, perfilId, storage } });
  const logs: string[] = [];
  const reel: ReelRuntime = {
    tooling: async () => ({ version: 'test', hdr: true }),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ffmpegTimeoutMs: 180_000,
    ffprobeTimeoutMs: 15_000,
    tempRoot,
    outputSpec: FAST,
    ...(remotion ? { remotion } : {}),
  };
  const logger = createLogger('debug', { write: (l: string) => void logs.push(l) });
  return { db, clienteId, piezaId: w.piezaId, storage, media: w.media, logs, deps: { db, storage, logger, reel } };
}

const tempLeftovers = async () => (await readdir(tempRoot)).filter((n) => n.startsWith('novaciel-reel-'));
const count = async (db: Db, table: string, clienteId: string) => Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE cliente_id = $1`, [clienteId])).rows[0].n);

/** Nothing was produced: no row, no stored production file, sources untouched, the piece where it was, no temp folder. */
async function expectNothingProduced(w: World) {
  for (const table of ['producciones', 'producciones_archivos', 'producciones_fuentes']) expect(await count(w.db, table, w.clienteId), table).toBe(0);
  expect(w.storage.keys().filter((k) => k.includes('/producidos/'))).toEqual([]);
  for (const m of w.media) expect(w.storage.has(m.clave_almacenamiento), 'a source was deleted').toBe(true);
  expect((await getPieza(w.db, w.clienteId, w.piezaId, { includeDescartados: true }))!.estado).toBe('guion_listo');
  expect(await tempLeftovers()).toEqual([]);
}

describeFfmpeg('a templated reel (real FFmpeg, fake text layer)', () => {
  it('records the template and its version, and the layer sequences go through the same verified pipeline', async () => {
    await withTestTransaction(async (db) => {
      const fake = new FakeCapaTextoAnimado();
      const w = await world(db, { licencia: 'gratuita', capaTexto: fake }, [`${SECRET} uno`, 'Dos', 'Tres']);
      const pieza = (await getPieza(db, w.clienteId, w.piezaId))!;
      const esperada = elegirPlantilla({ licencia: 'gratuita', kitVisual: SEED_PROFILE.kit_visual, trabajo: pieza.trabajo })!;

      const { produccion } = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      expect(produccion).toMatchObject({ plantilla: esperada.id, plantilla_version: esperada.version });
      expect(await getProduccionActual(db, w.clienteId, w.piezaId)).toEqual(produccion);
      const fila = (await db.query('SELECT plantilla, plantilla_version FROM producciones WHERE id = $1', [produccion.id])).rows[0];
      expect(fila).toEqual({ plantilla: esperada.id, plantilla_version: esperada.version });

      // One layer per scene with text (all three here), each of exactly the scene's 150 frames.
      expect(fake.llamadas.map((l) => [l.plantilla, l.version, l.fotogramas, l.ancho, l.alto, l.fps])).toEqual(
        [1, 2, 3].map(() => [esperada.id, esperada.version, 150, 1080, 1920, FPS]),
      );
      // The 7b verifier ran inside renderReel (size, codec, fps, frames, silent audio, tag allow-list, atoms).
      expect(produccion.archivos[0]).toMatchObject({ mime: 'video/mp4', ancho: 1080, alto: 1920, fps: 30, codec_video: 'h264', codec_audio: 'aac' });
      expect(await tempLeftovers()).toEqual([]);

      // Logs: the template, counts and times; never the copy or the temp path.
      const logs = w.logs.join('\n');
      expect(logs).toContain('reel rendered');
      expect(logs).toContain(esperada.id);
      for (const forbidden of [SECRET, 'Escena', 'novaciel-reel', 'ñá', tempRoot]) expect(logs.includes(forbidden), forbidden).toBe(false);
    });
  }, 180_000);

  it('a scene without text draws no layer', async () => {
    await withTestTransaction(async (db) => {
      const fake = new FakeCapaTextoAnimado();
      const w = await world(db, { licencia: 'gratuita', capaTexto: fake }, ['Uno', '', 'Tres']);
      await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      expect(fake.llamadas).toHaveLength(2);
    });
  }, 180_000);

  it('license unset: no template, the 7b PNG overlays, plantilla null', async () => {
    await withTestTransaction(async (db) => {
      const fake = new FakeCapaTextoAnimado();
      const w = await world(db, { licencia: undefined, capaTexto: fake });
      const { produccion } = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      expect(produccion).toMatchObject({ plantilla: null, plantilla_version: null });
      expect(fake.llamadas).toEqual([]);
    });
  }, 180_000);

  it('no Remotion runtime at all behaves like an unset license', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, undefined);
      const { produccion } = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      expect(produccion).toMatchObject({ plantilla: null, plantilla_version: null });
    });
  }, 180_000);

  it('failure policy: a template was chosen and its layer fails, so the piece fails and nothing is left', async () => {
    await withTestTransaction(async (db) => {
      const fake = new FakeCapaTextoAnimado();
      fake.fallarCon = new CapaTextoError('fallo_de_render');
      const w = await world(db, { licencia: 'gratuita', capaTexto: fake });
      const error = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CapaTextoError);
      await expectNothingProduced(w);
    });
  }, 180_000);

  it('failure policy: Remotion unavailable (no browser) fails the piece, it does not fall back to PNGs', async () => {
    await withTestTransaction(async (db) => {
      const capaTexto = crearCapaTextoRemotion({ licencia: 'gratuita', navegador: path.join(root, 'no-existe', 'chrome-headless-shell') });
      const w = await world(db, { licencia: 'gratuita', capaTexto });
      const error = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RemotionNoDisponibleError);
      await expectNothingProduced(w);
    });
  }, 180_000);

  it('glyphs the bundled font cannot draw are refused before anything is downloaded', async () => {
    await withTestTransaction(async (db) => {
      const fake = new FakeCapaTextoAnimado();
      const w = await world(db, { licencia: 'gratuita', capaTexto: fake }, ['Hola 😀', 'Dos', 'Tres']);
      const error = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedGlyphsError);
      expect(w.storage.downloads).toBe(0);
      expect(fake.llamadas).toEqual([]);
      await expectNothingProduced(w);
    });
  }, 180_000);

  it('isolation: another client sees nothing of the production or its template', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, { licencia: 'gratuita', capaTexto: new FakeCapaTextoAnimado() });
      await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      const otro = asClienteId((await createCliente(db)).id);
      expect(await getProduccionActual(db, otro, w.piezaId)).toBeNull();
      expect((await db.query('SELECT 1 FROM producciones WHERE cliente_id = $1', [otro])).rows).toEqual([]);
    });
  }, 180_000);
});

/**
 * How many pixels of the `n`-th frame (from 0) of a video are dark. The test clip is blue (3366cc) and the scrim of
 * the seed kit is light, so the only dark pixels are the text (#2b2b2b).
 */
async function oscurosEnFotograma(video: string, n: number, carpeta: string): Promise<number> {
  const salida = path.join(carpeta, `f-${n}.png`);
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', salida], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not sample a frame');
  const { data } = await sharp(salida).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let blancos = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i]! < 100 && data[i + 1]! < 100 && data[i + 2]! < 100) blancos++;
  return blancos;
}

describeFfmpeg('a templated reel (real FFmpeg and real Remotion)', () => {
  describeRemotion('words appear at their computed times', () => {
    it('the dark text of the scene grows at each word start and not before (frame samples of the final MP4)', async () => {
      await withTestTransaction(async (db) => {
        const capaTexto = crearCapaTextoRemotion({ licencia: 'gratuita', navegador: navegadorDeLasPruebas() });
        const texto = 'Cada mañana tostamos café de origen';
        const w = await world(db, undefined, [texto, '', '']);
        const brief = (await getBriefActual(db, w.clienteId, w.piezaId))!;
        const props = construirPropsPlantilla({
          plantilla: { id: 'palabra_a_palabra', version: 1 },
          escena: { orden: 1, texto, fotogramas: 150 },
          fps: FPS,
          colores: elegirColores(SEED_PROFILE.kit_visual),
          ancho: 1080,
          alto: 1920,
          medir: crearMedidor(),
        })!;
        const palabras = props.lineas.flatMap((l) => l.palabras);
        expect(palabras.length).toBe(6);

        const rows = (await db.query('SELECT id, clave_almacenamiento FROM media WHERE cliente_id = $1', [w.clienteId])).rows as { id: string; clave_almacenamiento: string }[];
        const deps: ReelRenderDeps = {
          storage: w.storage,
          tooling: async () => ({ version: 'test', hdr: true }),
          ffmpegPath: 'ffmpeg',
          ffprobePath: 'ffprobe',
          ffmpegTimeoutMs: 180_000,
          ffprobeTimeoutMs: 15_000,
          tempRoot,
          capaTexto,
          capaTimeoutMs: 120_000,
        };
        const muestras = await renderReel(
          deps,
          { guion: brief, fuentes: Object.fromEntries(rows.map((m) => [m.id, m.clave_almacenamiento])), kitVisual: SEED_PROFILE.kit_visual, plantilla: { id: 'palabra_a_palabra', version: 1 }, outputSpec: FAST },
          async (reel) => {
            expect(reel.plantilla).toEqual({ id: 'palabra_a_palabra', version: 1 });
            const carpeta = path.join(tempRoot, `muestras-${Date.now()}`);
            await mkdir(carpeta, { recursive: true });
            const salida: { antes: number; despues: number }[] = [];
            for (const p of palabras) {
              const antes = Math.max(0, p.inicioFotograma - 1);
              salida.push({ antes: await oscurosEnFotograma(reel.ruta, antes, carpeta), despues: await oscurosEnFotograma(reel.ruta, Math.min(149, p.inicioFotograma + 8), carpeta) });
            }
            await rm(carpeta, { recursive: true, force: true });
            return salida;
          },
        );

        expect(muestras[0]!.antes).toBe(0); // nothing of the text before the first word
        for (const [i, m] of muestras.entries()) {
          expect(m.despues, `word ${i} shows up`).toBeGreaterThan(m.antes);
          // The next word is not there yet: just before it starts there is no more than what the previous one left.
          if (i > 0) expect(m.antes, `word ${i} is not early`).toBeLessThanOrEqual(muestras[i - 1]!.despues * 1.05 + 20);
        }
        expect(await tempLeftovers()).toEqual([]);
      });
    }, 300_000);
  });
});
