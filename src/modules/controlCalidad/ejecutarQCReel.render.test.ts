import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { describeFfmpeg } from '../../../tests/utils/ffmpeg.js';
import { remux, solidClip } from '../../../tests/utils/ffmpegClips.js';
import { producibleWorld, type WorldClip } from '../../../tests/utils/produccionWorld.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { runInTransaction } from '../../db/transaction.js';
import type { Db } from '../../db/types.js';
import { runFfmpeg } from '../../lib/media/ffmpeg/runFfmpeg.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { getHistorial } from '../piezas/index.js';
import type { ProduccionView } from '../produccion/produccionRepository.js';
import { producirPieza, type ReelRuntime } from '../produccion/produccionService.js';
import type { ClienteId } from '../shared/clienteId.js';
import { ejecutarQC, type QcDeps } from './ejecutarQC.js';

// Quality control of a REAL reel (FFmpeg and ffprobe). ONE good reel is rendered in beforeAll; every case
// that must fail is a copy of that file changed with a stream copy or a few bytes, so no code needs its own
// full render. The reel is committed once and each test runs in a transaction that is rolled back.

const SISTEMA = { tipo: 'sistema' } as const;

/** The same clean-copy flags the renderer uses, so a copy carries none of the tags that FFmpeg adds on its own. */
const LIMPIO = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-metadata:s:v:0', 'encoder='] as const;

let raiz: string;
let tempRoot: string;
let base: { clienteId: ClienteId; piezaId: string; produccion: ProduccionView; bytes: Buffer; archivoBueno: string };

beforeAll(async () => {
  raiz = await mkdtemp(path.join(os.tmpdir(), 'novaciel qc reel ñá '));
  tempRoot = path.join(raiz, 'trabajo');
  await mkdir(tempRoot, { recursive: true });
  const clipsDir = path.join(raiz, 'clips');
  await mkdir(clipsDir, { recursive: true });
  const clip: WorldClip = { bytes: await readFile(solidClip(clipsDir, 'ok.mp4', '3366cc')), ancho: 720, alto: 1280, duracionMs: 6000 };

  await cleanupDomainTables(getTestPool());
  const pool = getTestPool();
  const world = await runInTransaction(pool, (tx) =>
    producibleWorld(tx, { formato: 'reel', clips: [clip], sceneSeconds: 5, texts: ['Primera escena', 'Segunda escena', 'Tercera escena'] }),
  );
  const reel: ReelRuntime = {
    tooling: async () => ({ version: 'test', hdr: true }),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ffmpegTimeoutMs: 180_000,
    ffprobeTimeoutMs: 15_000,
    tempRoot,
    outputSpec: { preset: 'veryfast' },
    runFfmpeg,
  };
  // The world stored the clips in its own storage: the production reads them from there.
  const { produccion } = await producirPieza({ db: pool, storage: world.storage, reel }, world.clienteId, world.piezaId, SISTEMA);
  const archivo = produccion.archivos[0]!;
  const bytes = await world.storage.get(archivo.clave_almacenamiento);
  const archivoBueno = path.join(raiz, 'bueno.mp4');
  await writeFile(archivoBueno, bytes);
  base = { clienteId: world.clienteId, piezaId: world.piezaId, produccion, bytes, archivoBueno };
}, 240_000);

afterAll(async () => {
  await cleanupDomainTables(getTestPool());
  await closeTestPool();
  await rm(raiz, { recursive: true, force: true });
});

interface Variante {
  /** The bytes stored instead of the good reel. */
  bytes?: Buffer;
  maxReelBytes?: number;
  /** Changes the production row in the test transaction (productions are immutable: the trigger is disabled there). */
  retocar?: (db: Db) => Promise<void>;
}

async function controlar(v: Variante = {}) {
  return withTestTransaction(async (db) => {
    const clave = base.produccion.archivos[0]!.clave_almacenamiento;
    const storage = new FakeStorage();
    await storage.put(clave, v.bytes ?? base.bytes);
    if (v.retocar) {
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE producciones DISABLE TRIGGER producciones_before_update_delete');
      await db.query('SET CONSTRAINTS ALL DEFERRED');
      await v.retocar(db);
    }
    const deps: QcDeps = {
      db,
      storage,
      tempRoot,
      reel: { ffprobePath: 'ffprobe', ffprobeTimeoutMs: 15_000, ...(v.maxReelBytes !== undefined ? { maxReelBytes: v.maxReelBytes } : {}) },
    };
    const resultado = await ejecutarQC(deps, base.clienteId, base.piezaId, SISTEMA);
    const historial = (await getHistorial(db, base.clienteId, base.piezaId)).slice(-1)[0]!;
    return { ...resultado, historial };
  });
}

const por = (checks: { codigo: string }[], codigo: string) => checks.find((c) => c.codigo === codigo) as { codigo: string; resultado: string; parametros: Record<string, unknown> } | undefined;
const leftovers = () => readdir(tempRoot);

describeFfmpeg('ejecutarQC: a real reel', () => {
  it('passes: every reel family is evaluated and the piece moves to revision_novaciel', async () => {
    const { revision, pieza, historial } = await controlar();
    expect(revision.resultado).toBe('aprobado');
    expect(revision.codigos_fallo).toEqual([]);
    for (const codigo of ['reel_formato', 'reel_etiquetas', 'reel_ubicacion_atomo', 'reel_tamano_maximo', 'reel_duracion', 'plantilla_invalida', 'archivo_hash_distinto', 'hash_pieza_distinto', 'diapositivas_cantidad']) {
      expect(por(revision.checks, codigo), codigo).toMatchObject({ resultado: 'pasa' });
    }
    expect(pieza.estado).toBe('revision_novaciel');
    expect(historial).toMatchObject({ desde: 'en_control_calidad', hacia: 'revision_novaciel' });
    expect(await leftovers()).toEqual([]); // the temporary folder of the run is always removed
  });

  it('reel_etiquetas: a copy with a metadata tag the allow-list does not know', async () => {
    const variante = path.join(raiz, 'etiqueta.mp4');
    remux(base.archivoBueno, variante, [...LIMPIO, '-metadata', 'title=Algo privado', '-movflags', '+faststart']);
    const { revision, pieza } = await controlar({ bytes: await readFile(variante) });
    expect(revision.resultado).toBe('rechazado');
    expect(revision.codigos_fallo).toContain('reel_etiquetas');
    expect(por(revision.checks, 'reel_etiquetas')).toMatchObject({ parametros: { razon: ['etiqueta_no_permitida'] } });
    expect(JSON.stringify(revision.checks)).not.toContain('Algo privado');
    expect(pieza.estado).toBe('en_produccion');
  });

  it('reel_formato: a copy without faststart (the moov box at the end)', async () => {
    const variante = path.join(raiz, 'sin-faststart.mp4');
    remux(base.archivoBueno, variante, [...LIMPIO]);
    const { revision } = await controlar({ bytes: await readFile(variante) });
    expect(revision.codigos_fallo).toContain('reel_formato');
    expect(por(revision.checks, 'reel_formato')).toMatchObject({ resultado: 'no_pasa', parametros: { razon: ['faststart'] } });
  });

  it('reel_ubicacion_atomo: a copy with a location atom appended', async () => {
    // A top-level (c)xyz box, 16 bytes, the atom a phone writes for the location.
    const atomo = Buffer.from([0x00, 0x00, 0x00, 0x10, 0xa9, 0x78, 0x79, 0x7a, 0x2b, 0x34, 0x30, 0x2e, 0x37, 0x31, 0x32, 0x38]);
    const { revision } = await controlar({ bytes: Buffer.concat([base.bytes, atomo]) });
    expect(revision.codigos_fallo).toContain('reel_ubicacion_atomo');
    expect(por(revision.checks, 'reel_ubicacion_atomo')).toMatchObject({ resultado: 'no_pasa', parametros: { razon: ['atomo_no_permitido'] } });
  });

  it('reel_duracion: a trimmed copy, shorter than 15 seconds', async () => {
    const variante = path.join(raiz, 'recortado.mp4');
    remux(base.archivoBueno, variante, [...LIMPIO, '-t', '8', '-movflags', '+faststart']);
    const { revision } = await controlar({ bytes: await readFile(variante) });
    expect(revision.codigos_fallo).toContain('reel_duracion');
    expect(por(revision.checks, 'reel_duracion')).toMatchObject({ resultado: 'no_pasa', parametros: { minimo_s: 15, maximo_s: 30 } });
  });

  it('reel_tamano_maximo: a size cap lower than the file (injected)', async () => {
    const { revision } = await controlar({ maxReelBytes: 1000 });
    expect(revision.codigos_fallo).toContain('reel_tamano_maximo');
    expect(por(revision.checks, 'reel_tamano_maximo')).toMatchObject({ resultado: 'no_pasa', parametros: { razon: ['tamano_maximo'] } });
  });

  it('plantilla_invalida: the recorded template does not exist (only the production row changes)', async () => {
    const { revision } = await controlar({
      retocar: async (db) => void (await db.query("UPDATE producciones SET plantilla = 'inexistente', plantilla_version = 1 WHERE id = $1", [base.produccion.id])),
    });
    expect(revision.codigos_fallo).toContain('plantilla_invalida');
    expect(por(revision.checks, 'plantilla_invalida')).toMatchObject({ resultado: 'no_pasa', parametros: { plantilla: 'inexistente', version: 1 } });
  });

  it('archivo_hash_distinto: a copy with other bytes of the same video is not the file that was produced', async () => {
    const variante = path.join(raiz, 'otra-copia.mp4');
    remux(base.archivoBueno, variante, [...LIMPIO]);
    const { revision } = await controlar({ bytes: await readFile(variante) });
    expect(revision.codigos_fallo).toContain('archivo_hash_distinto');
    expect(revision.codigos_fallo).toContain('hash_pieza_distinto');
  });

  it('the temporary folder is removed also when a file is missing, and a missing video is reported', async () => {
    const resultado = await withTestTransaction(async (db) => {
      const deps: QcDeps = { db, storage: new FakeStorage(), tempRoot, reel: { ffprobePath: 'ffprobe', ffprobeTimeoutMs: 15_000 } };
      return ejecutarQC(deps, base.clienteId, base.piezaId, SISTEMA);
    });
    expect(resultado.revision.codigos_fallo).toContain('archivo_ilegible');
    expect(await leftovers()).toEqual([]);
  });
});
