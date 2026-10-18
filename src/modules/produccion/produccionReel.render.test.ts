import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeFfmpeg } from '../../../tests/utils/ffmpeg.js';
import { hdrClip, solidClip } from '../../../tests/utils/ffmpegClips.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import {
  createAutorizacionImagen,
  createCliente,
  createMediaAutorizacion,
  createPerfilMarca,
  createPlanSemanal,
} from '../../../tests/utils/factories/index.js';
import { producibleWorld, type WorldClip } from '../../../tests/utils/produccionWorld.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { FfmpegRunError, runFfmpeg } from '../../lib/media/ffmpeg/runFfmpeg.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { SEED_PROFILE } from '../../scripts/seedProfile.js';
import { getHistorial, getPieza, pausarPieza, PiezaNotFoundError } from '../piezas/index.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import {
  BriefConFaltantesError,
  DuracionTotalFueraDeRangoError,
  EscenaMasLargaQueLaFuenteError,
  FuenteDeVideoIlegibleError,
  FuentesMuyPequenasError,
  HdrNoSoportadoError,
  MarcasFueraDeRangoError,
  ProduccionMediaNoUsableError,
  ProduccionObsoletaError,
  ReelNoConfiguradoError,
} from './errors.js';
import { computePieceHash } from './pieceHash.js';
import { ejecutarJobProducirPieza } from './produccionJobs.js';
import { getProduccionActual, listProduccionVersions } from './produccionRepository.js';
import { producirPieza, type ProduccionDeps, type ReelRuntime } from './produccionService.js';

// Reels through producirPieza, with the real FFmpeg and a fake storage. The 7a tests cover the parts
// that do not depend on the format (states, locks, versions); these cover what a reel adds.

const SISTEMA = { tipo: 'sistema' } as const;
const SECRET = 'SECRETO-DEL-REEL';
const FAST = { preset: 'veryfast' } as const;

let root: string;
let tempRoot: string;
const clips = {} as Record<'ok' | 'corto' | 'pequeno' | 'hdr' | 'corrupto', WorldClip>;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'novaciel reel servicio ñá '));
  tempRoot = path.join(root, 'trabajo');
  await mkdir(tempRoot, { recursive: true });
  const dir = path.join(root, 'clips');
  await mkdir(dir, { recursive: true });
  const bytes = (file: string) => readFile(file);
  clips.ok = { bytes: await bytes(solidClip(dir, 'ok.mp4', '3366cc')), ancho: 720, alto: 1280, duracionMs: 6000 };
  clips.corto = { bytes: await bytes(solidClip(dir, 'corto.mp4', '33aa44', { seconds: 3 })), ancho: 720, alto: 1280, duracionMs: 3000 };
  clips.pequeno = { bytes: await bytes(solidClip(dir, 'pequeno.mp4', 'cc3333', { width: 640, height: 360 })), ancho: 640, alto: 360, duracionMs: 6000 };
  clips.hdr = { bytes: await bytes(hdrClip(dir, 'hdr.mp4', 'smpte2084')), ancho: 720, alto: 1280, duracionMs: 6000 };
  clips.corrupto = { bytes: Buffer.from(Array.from({ length: 4000 }, (_v, i) => (i * 131 + 7) % 256)), ancho: 720, alto: 1280, duracionMs: 6000 };
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** FakeStorage with hooks to change the world, or fail, while the service works. */
class ReelStorage extends FakeStorage {
  /** Runs once, the first time a source is read (after the free checks). */
  onFirstGet?: () => Promise<void>;
  /** Runs once, right after the MP4 was stored (before the write transaction). */
  onAfterProducido?: () => Promise<void>;
  /** Storing the MP4 fails. */
  failProducido = false;
  downloads = 0;
  private hooked = false;
  override async get(key: string): Promise<Buffer> {
    if (this.onFirstGet && !this.hooked) {
      this.hooked = true;
      await this.onFirstGet();
    }
    return super.get(key);
  }
  override async getFile(key: string, destPath: string): Promise<void> {
    this.downloads += 1;
    return super.getFile(key, destPath);
  }
  override async putFile(key: string, filePath: string, contentType?: string): Promise<void> {
    if (!key.includes('/producidos/')) return super.putFile(key, filePath, contentType);
    if (this.failProducido) throw new Error('disk full');
    await super.putFile(key, filePath, contentType);
    const hook = this.onAfterProducido;
    this.onAfterProducido = undefined;
    if (hook) await hook();
  }
  producidos(): string[] {
    return this.keys().filter((key) => key.includes('/producidos/'));
  }
}

interface ReelWorld {
  db: Db;
  clienteId: ClienteId;
  planId: string;
  perfilId: string;
  piezaId: string;
  storage: ReelStorage;
  media: { id: string; clave_almacenamiento: string }[];
  logs: string[];
  /** Times ffmpeg was started. */
  runs: { count: number };
  deps: ProduccionDeps;
}

interface ReelWorldOptions {
  clips?: WorldClip[];
  faltantes?: number[];
  sceneSeconds?: number;
  texts?: string[];
  hdrToneMap?: boolean;
  sinRuntime?: boolean;
  runFfmpeg?: ReelRuntime['runFfmpeg'];
}

async function reelWorld(db: Db, o: ReelWorldOptions = {}): Promise<ReelWorld> {
  const clienteId = asClienteId((await createCliente(db)).id);
  const perfilId = (await createPerfilMarca(db, { clienteId, kit_visual: structuredClone(SEED_PROFILE.kit_visual) })).id;
  const planId = (await createPlanSemanal(db, { clienteId, estado: 'aprobado', perfilMarcaId: perfilId })).id;
  const storage = new ReelStorage();
  const world = await producibleWorld(db, {
    formato: 'reel',
    clips: o.clips ?? [clips.ok],
    ...(o.faltantes ? { faltantes: o.faltantes } : {}),
    ...(o.sceneSeconds ? { sceneSeconds: o.sceneSeconds } : {}),
    ...(o.texts ? { texts: o.texts } : {}),
    base: { clienteId, planId, perfilId, storage },
  });
  const logs: string[] = [];
  const logger = createLogger('debug', { write: (l: string) => void logs.push(l) });
  const runs = { count: 0 };
  const reel: ReelRuntime = {
    tooling: async () => ({ version: 'test', hdr: o.hdrToneMap ?? true }),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ffmpegTimeoutMs: 180_000,
    ffprobeTimeoutMs: 15_000,
    tempRoot,
    outputSpec: FAST,
    runFfmpeg:
      o.runFfmpeg ??
      (async (args, options) => {
        runs.count += 1;
        return runFfmpeg(args, options);
      }),
  };
  return { db, clienteId, planId, perfilId, piezaId: world.piezaId, storage, media: world.media, logs, runs, deps: { db, storage, logger, ...(o.sinRuntime ? {} : { reel }) } };
}

const count = async (db: Db, table: string, clienteId: string) => Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE cliente_id = $1`, [clienteId])).rows[0].n);
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const tempLeftovers = async () => (await readdir(tempRoot)).filter((name) => name.startsWith('novaciel-reel-'));

/** Nothing was produced: no row, no stored production file, sources untouched, the piece where it was, no temp folder. */
async function expectNothingProduced(w: ReelWorld, estado = 'guion_listo') {
  for (const table of ['producciones', 'producciones_archivos', 'producciones_fuentes']) expect(await count(w.db, table, w.clienteId), table).toBe(0);
  expect(w.storage.producidos()).toEqual([]);
  for (const m of w.media) expect(w.storage.has(m.clave_almacenamiento), 'a source was deleted').toBe(true);
  expect((await getPieza(w.db, w.clienteId, w.piezaId, { includeDescartados: true }))!.estado).toBe(estado);
  expect(await tempLeftovers()).toEqual([]);
}

describeFfmpeg('producirPieza: a reel is produced', () => {
  it('stores one MP4 with its record, its sources scene by scene, the piece hash, state, history and audit', async () => {
    await withTestTransaction(async (db) => {
      // Scene 2 starts one second into its clip: the stretch used is 1000 to 6000 ms.
      const w = await reelWorld(db, { clips: [clips.ok, { ...clips.ok, entradaMs: 1000, salidaMs: 6000 }, clips.ok] });
      const { produccion, pieza } = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);

      expect(produccion).toMatchObject({ pieza_id: w.piezaId, version: 1, es_actual: true, red: 'instagram', hash_version: 'np1', creado_por: null });
      expect(produccion.archivos).toHaveLength(1);
      const archivo = produccion.archivos[0]!;
      expect(archivo.clave_almacenamiento).toMatch(new RegExp(`^${w.clienteId}/producidos/[0-9a-f-]{36}\\.mp4$`));
      expect(archivo).toMatchObject({ orden: 1, mime: 'video/mp4', ancho: 1080, alto: 1920, media_id: w.media[0]!.id, fps: 30, codec_video: 'h264', codec_audio: 'aac' });
      expect(Math.abs(archivo.duracion_ms! - 15_000)).toBeLessThanOrEqual(100);
      const stored = await w.storage.get(archivo.clave_almacenamiento);
      expect(archivo.sha256).toBe(sha256(stored));
      expect(archivo.tamano_bytes).toBe(stored.length);
      expect(stored.subarray(4, 8).toString('latin1')).toBe('ftyp');

      // The stretch of each clip that is in the file, scene by scene.
      expect(archivo.fuentes).toEqual([
        { escena: 1, media_id: w.media[0]!.id, entrada_ms: 0, salida_ms: 5000 },
        { escena: 2, media_id: w.media[1]!.id, entrada_ms: 1000, salida_ms: 6000 },
        { escena: 3, media_id: w.media[2]!.id, entrada_ms: 0, salida_ms: 5000 },
      ]);

      // One empty alt text for the one video; the piece hash is computePieceHash over the stored data.
      expect(produccion.textos_alternativos).toEqual(['']);
      expect(produccion.hash_pieza).toBe(
        computePieceHash({ red: 'instagram', archivos: [Buffer.from(archivo.sha256, 'hex')], textoPublicacion: produccion.texto_publicacion, hashtags: produccion.hashtags, textosAlternativos: [''], ubicacion: produccion.ubicacion }).toString('hex'),
      );

      expect(pieza.estado).toBe('en_control_calidad');
      expect((await getHistorial(db, w.clienteId, w.piezaId)).slice(-2).map((h) => [h.desde, h.hacia, h.motivo])).toEqual([
        ['guion_listo', 'en_produccion', 'Production started (version 1)'],
        ['en_produccion', 'en_control_calidad', 'Production finished (version 1)'],
      ]);
      const audit = await auditRowsFor(db, 'producciones', produccion.id);
      expect(audit.map((a) => a.accion)).toEqual(['crear']);
      expect(audit[0]!.datos_despues).toMatchObject({ archivos: 1, escenas: 3, hash_pieza: produccion.hash_pieza });
      expect(JSON.stringify(audit)).not.toMatch(/Hecho con calma|Escena|Nuestro barrio/);

      expect(await getProduccionActual(db, w.clienteId, w.piezaId)).toEqual(produccion);
      expect(await count(db, 'producciones_fuentes', w.clienteId)).toBe(3);
      expect(await tempLeftovers()).toEqual([]);
    });
  }, 120_000);

  it('hash drift: recomputing the hash from the rows and the stored bytes gives the stored hash', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db);
      const { produccion } = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      const row = (await db.query('SELECT red, texto_publicacion, hashtags, textos_alternativos, ubicacion, hash_pieza FROM producciones WHERE id = $1', [produccion.id])).rows[0];
      const files = (await db.query('SELECT clave_almacenamiento FROM producciones_archivos WHERE produccion_id = $1 ORDER BY orden', [produccion.id])).rows;
      const hashes = await Promise.all(files.map(async (f) => createHash('sha256').update(await w.storage.get(f.clave_almacenamiento)).digest()));
      const recomputed = computePieceHash({ red: row.red, archivos: hashes, textoPublicacion: row.texto_publicacion, hashtags: row.hashtags, textosAlternativos: row.textos_alternativos, ubicacion: row.ubicacion });
      expect(recomputed.equals(row.hash_pieza)).toBe(true);
    });
  }, 120_000);

  it('tone-maps an HDR clip: the reel is produced and stored as SDR', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db, { clips: [clips.hdr, clips.ok, clips.ok] });
      const { produccion } = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      expect(produccion.archivos[0]).toMatchObject({ mime: 'video/mp4', codec_video: 'h264' });
      expect(produccion.archivos[0]!.fuentes.map((f) => f.media_id)).toEqual(w.media.map((m) => m.id));
    });
  }, 120_000);

  it('logs hold ids, counts and keys: no copy, no FFmpeg output, no temporary path', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db, { texts: [`${SECRET} uno`, 'Dos', 'Tres'] });
      const { produccion } = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      const logs = w.logs.join('\n');
      expect(logs).toContain('production stored');
      expect(logs).toContain('reel rendered');
      expect(logs).toContain(produccion.id);
      for (const forbidden of [SECRET, 'Hecho con calma', 'Escena', 'Nuestro barrio', 'El origen', 'novaciel-reel', 'ñá', tempRoot, 'libx264', 'Lavf']) expect(logs.includes(forbidden), forbidden).toBe(false);
    });
  }, 120_000);
});

describeFfmpeg('producirPieza: a reel that cannot be produced leaves nothing behind', () => {
  const refused = async (db: Db, w: ReelWorld) => producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);

  it('slots without media, before any download', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db, { faltantes: [2] });
      const error = await refused(db, w);
      expect(error).toBeInstanceOf(BriefConFaltantesError);
      expect((error as BriefConFaltantesError).ordenes).toEqual([2]);
      expect(w.storage.downloads).toBe(0);
      await expectNothingProduced(w);
    });
  });

  it('a clip that is too small: the media id and the scene', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db, { clips: [clips.ok, clips.pequeno, clips.ok] });
      const error = await refused(db, w);
      expect(error).toBeInstanceOf(FuentesMuyPequenasError);
      expect((error as FuentesMuyPequenasError).mediaIds).toEqual([w.media[1]!.id]);
      expect((error as FuentesMuyPequenasError).ordenes).toEqual([2]);
      expect(w.runs.count).toBe(0);
      await expectNothingProduced(w);
    });
  });

  it('a source shorter than its scene', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db, { clips: [clips.ok, clips.corto, clips.ok] }); // 5 s asked of a 3 s clip
      const error = await refused(db, w);
      expect(error).toBeInstanceOf(EscenaMasLargaQueLaFuenteError);
      expect((error as EscenaMasLargaQueLaFuenteError).escenas).toEqual([2]);
      await expectNothingProduced(w);
    });
  });

  it('in/out marks beyond the real clip', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db, { clips: [{ ...clips.ok, entradaMs: 1000, salidaMs: 9000 }, clips.ok, clips.ok] }); // the clip lasts 6 s
      const error = await refused(db, w);
      expect(error).toBeInstanceOf(MarcasFueraDeRangoError);
      expect((error as MarcasFueraDeRangoError).escenas).toEqual([1]);
      await expectNothingProduced(w);
    });
  });

  it('a total outside 15 to 30 seconds', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db, { sceneSeconds: 4 }); // 3 scenes of 4 s
      expect(await refused(db, w)).toBeInstanceOf(DuracionTotalFueraDeRangoError);
      await expectNothingProduced(w);
    });
  });

  it('an HDR clip when this FFmpeg cannot tone-map it', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db, { clips: [clips.ok, clips.hdr, clips.ok], hdrToneMap: false });
      const error = await refused(db, w);
      expect(error).toBeInstanceOf(HdrNoSoportadoError);
      expect((error as HdrNoSoportadoError).escenas).toEqual([2]);
      expect(w.runs.count).toBe(0);
      await expectNothingProduced(w);
    });
  });

  it('a corrupt clip, and a photo where a clip should be', async () => {
    await withTestTransaction(async (db) => {
      const corrupt = await reelWorld(db, { clips: [clips.ok, clips.corrupto, clips.ok] });
      const error = await refused(db, corrupt);
      expect(error).toBeInstanceOf(FuenteDeVideoIlegibleError);
      expect(error).toMatchObject({ mediaId: corrupt.media[1]!.id, razon: 'no_se_pudo_leer' });
      await expectNothingProduced(corrupt);

      const photo = await reelWorld(db);
      await db.query(`UPDATE media SET tipo = 'foto', duracion_ms = NULL, mime = 'image/jpeg' WHERE id = $1`, [photo.media[2]!.id]);
      const photoError = await refused(db, photo);
      expect(photoError).toMatchObject({ name: 'FuenteDeVideoIlegibleError', mediaId: photo.media[2]!.id, razon: 'sin_video' });
      expect(photo.storage.downloads).toBe(0);
      await expectNothingProduced(photo);
    });
  });

  it('a process with no FFmpeg configured', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db, { sinRuntime: true });
      expect(await refused(db, w)).toBeInstanceOf(ReelNoConfiguradoError);
      await expectNothingProduced(w);
    });
  });
});

describeFfmpeg('producirPieza: reel failures after the render', () => {
  it('storing the MP4 fails: no row, sources untouched, no temporary folder', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db);
      w.storage.failProducido = true;
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toThrow('disk full');
      await expectNothingProduced(w);
    });
  }, 120_000);

  it('a piece paused while rendering makes it stale: the MP4 is deleted, the sources stay', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db);
      w.storage.onAfterProducido = async () => {
        await pausarPieza(db, w.clienteId, w.piezaId, SISTEMA);
      };
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toBeInstanceOf(ProduccionObsoletaError);
      expect(w.storage.producidos()).toEqual([]);
      expect(await count(db, 'producciones', w.clienteId)).toBe(0);
      for (const m of w.media) expect(w.storage.has(m.clave_almacenamiento)).toBe(true);
      expect(await tempLeftovers()).toEqual([]);
    });
  }, 120_000);

  it('two productions at once: one wins, the other deletes its MP4 and only the winner remains', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db);
      let winner: Awaited<ReturnType<typeof producirPieza>> | undefined;
      w.storage.onFirstGet = async () => {
        winner = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      };
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toBeInstanceOf(ProduccionObsoletaError);
      expect(winner!.produccion.version).toBe(1);
      expect(w.storage.producidos()).toEqual(winner!.produccion.archivos.map((a) => a.clave_almacenamiento));
      expect(await count(db, 'producciones', w.clienteId)).toBe(1);
      expect(await count(db, 'producciones_fuentes', w.clienteId)).toBe(3);
      expect(await tempLeftovers()).toEqual([]);
    });
  }, 180_000);
});

describeFfmpeg('producirPieza: re-production of a reel', () => {
  it('makes version 2, keeps version 1 readable with its file and sources, and shows the cycle', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db);
      const v1 = (await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).produccion;
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toMatchObject({ name: 'ProduccionExistenteError' });
      const v2 = (await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA, { reproducir: true })).produccion;

      expect([v2.version, v2.es_actual]).toEqual([2, true]);
      const versions = await listProduccionVersions(db, w.clienteId, w.piezaId);
      expect(versions.map((v) => [v.version, v.es_actual])).toEqual([[1, false], [2, true]]);
      expect(versions[0]!.archivos[0]!.fuentes).toHaveLength(3);
      expect(versions[0]).toEqual({ ...v1, es_actual: false });
      expect(w.storage.has(v1.archivos[0]!.clave_almacenamiento)).toBe(true);
      expect(w.storage.has(v2.archivos[0]!.clave_almacenamiento)).toBe(true);
      expect(v1.archivos[0]!.clave_almacenamiento).not.toBe(v2.archivos[0]!.clave_almacenamiento);
      expect((await getHistorial(db, w.clienteId, w.piezaId)).slice(-4).map((h) => [h.desde, h.hacia])).toEqual([
        ['guion_listo', 'en_produccion'],
        ['en_produccion', 'en_control_calidad'],
        ['en_control_calidad', 'en_produccion'],
        ['en_produccion', 'en_control_calidad'],
      ]);
    });
  }, 180_000);
});

describeFfmpeg('producirPieza: every source clip of a reel must be usable, not only the first', () => {
  const lose: Record<string, (db: Db, w: ReelWorld, mediaId: string) => Promise<void>> = {
    deleted: async (db, _w, id) => void (await db.query('UPDATE media SET eliminado_en = now() WHERE id = $1', [id])),
    'rights expired': async (db, _w, id) => void (await db.query('UPDATE media SET derechos_hasta = now() WHERE id = $1', [id])),
    'authorization revoked': async (db, w, id) => {
      await db.query('UPDATE media SET aparecen_personas = true WHERE id = $1', [id]);
      await createMediaAutorizacion(db, { mediaId: id, clienteId: w.clienteId, autorizacionId: (await createAutorizacionImagen(db, { clienteId: w.clienteId, revoked: true })).id });
    },
  };

  it.each(Object.keys(lose).flatMap((how) => [1, 2].map((scene) => [how, scene] as const)))(
    'before rendering: %s on scene %i+1 (never the first) is refused with only that id, nothing downloaded or run',
    async (how, index) => {
      await withTestTransaction(async (db) => {
        const w = await reelWorld(db);
        await lose[how]!(db, w, w.media[index]!.id);
        const error = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProduccionMediaNoUsableError);
        expect((error as ProduccionMediaNoUsableError).mediaIds).toEqual([w.media[index]!.id]);
        expect(w.storage.downloads).toBe(0);
        expect(w.runs.count).toBe(0);
        await expectNothingProduced(w);
      });
    },
  );

  it('the first clip is covered too, and several lost clips are all named', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db);
      await lose.deleted!(db, w, w.media[0]!.id);
      await lose['rights expired']!(db, w, w.media[2]!.id);
      const error = (await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e)) as ProduccionMediaNoUsableError;
      expect([...error.mediaIds].sort()).toEqual([w.media[0]!.id, w.media[2]!.id].sort());
      await expectNothingProduced(w);
    });
  });

  it.each([1, 2])('between the checks and the write: a clip of scene %i+1 loses its rights after the MP4 was stored; refused with that id, the MP4 deleted', async (index) => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db);
      w.storage.onAfterProducido = async () => {
        await lose['rights expired']!(db, w, w.media[index]!.id);
      };
      const error = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProduccionMediaNoUsableError);
      expect((error as ProduccionMediaNoUsableError).mediaIds).toEqual([w.media[index]!.id]);
      expect(w.runs.count).toBe(1); // it did render: the loss happened after
      await expectNothingProduced(w);
    });
  }, 120_000);
});

describeFfmpeg('producirPieza: reels and clients', () => {
  it("client A cannot produce, read or see the sources of client B's reel", async () => {
    await withTestTransaction(async (db) => {
      const a = await reelWorld(db);
      const b = await reelWorld(db);
      await producirPieza(b.deps, b.clienteId, b.piezaId, SISTEMA);

      await expect(producirPieza(a.deps, a.clienteId, b.piezaId, SISTEMA, { reproducir: true })).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(await getProduccionActual(db, a.clienteId, b.piezaId)).toBeNull();
      expect(await listProduccionVersions(db, a.clienteId, b.piezaId)).toEqual([]);
      expect(await count(db, 'producciones_fuentes', a.clienteId)).toBe(0);
      expect(await count(db, 'producciones_fuentes', b.clienteId)).toBe(3);
      expect(a.storage.producidos()).toEqual([]);
    });
  }, 120_000);
});

describeFfmpeg('the production job with reels', () => {
  it('ends "rechazado" with the error name for the refusals caused by the brief or the clips, storing nothing', async () => {
    await withTestTransaction(async (db) => {
      const cases: [string, ReelWorldOptions][] = [
        ['FuentesMuyPequenasError', { clips: [clips.ok, clips.pequeno, clips.ok] }],
        ['EscenaMasLargaQueLaFuenteError', { clips: [clips.ok, clips.corto, clips.ok] }],
        ['MarcasFueraDeRangoError', { clips: [{ ...clips.ok, entradaMs: 1000, salidaMs: 9000 }, clips.ok, clips.ok] }],
        ['DuracionTotalFueraDeRangoError', { sceneSeconds: 4 }],
        ['HdrNoSoportadoError', { clips: [clips.hdr, clips.ok, clips.ok], hdrToneMap: false }],
        ['FuenteDeVideoIlegibleError', { clips: [clips.ok, clips.corrupto, clips.ok] }],
        ['BriefConFaltantesError', { faltantes: [3] }],
      ];
      for (const [name, options] of cases) {
        const w = await reelWorld(db, options);
        expect(await ejecutarJobProducirPieza(w.deps, { clienteId: w.clienteId, piezaId: w.piezaId }), name).toMatchObject({ resultado: 'rechazado', codigo: name });
        await expectNothingProduced(w);
      }
    });
  }, 120_000);

  it('fails the job (does not reject quietly) when FFmpeg fails or is not configured', async () => {
    await withTestTransaction(async (db) => {
      const failing = await reelWorld(db, { runFfmpeg: async () => Promise.reject(new FfmpegRunError('filtro', 1)) });
      await expect(ejecutarJobProducirPieza(failing.deps, { clienteId: failing.clienteId, piezaId: failing.piezaId })).rejects.toBeInstanceOf(FfmpegRunError);
      await expectNothingProduced(failing);

      const none = await reelWorld(db, { sinRuntime: true });
      await expect(ejecutarJobProducirPieza(none.deps, { clienteId: none.clienteId, piezaId: none.piezaId })).rejects.toBeInstanceOf(ReelNoConfiguradoError);
    });
  });

  it('produces a reel and reports metadata only', async () => {
    await withTestTransaction(async (db) => {
      const w = await reelWorld(db);
      const output = await ejecutarJobProducirPieza(w.deps, { clienteId: w.clienteId, piezaId: w.piezaId });
      expect(output).toMatchObject({ resultado: 'produccion_creada', version: 1, archivos: 1 });
      expect(JSON.stringify(output)).not.toMatch(/Escena|Hecho con calma|producidos/);
    });
  }, 120_000);
});
