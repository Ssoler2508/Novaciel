import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Db } from '../../db/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { PiezaNotFoundError } from '../piezas/errors.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { computePieceHash } from '../produccion/pieceHash.js';
import { hashFile, verificarMediaYHechos } from '../produccion/produccionService.js';
import type { ClienteId } from '../shared/clienteId.js';
import { getProduccionActualBasica, listRegistros } from './aprobacionesRepository.js';
import { ArchivoAlteradoError, HashPiezaNoCoincideError, PiezaNoPublicableError, SinAprobacionVigenteError } from './errors.js';
import { estadoAprobacion } from './estadoAprobacion.js';

// THE GATE (rule 1): Step 10 calls this right before sending. It READS only: it changes nothing and it
// does NOT lock. Step 10 must call it with the piece locked, or re-check immediately before sending, so
// nothing can change between the check and the publish (ADR-05).
//
// It trusts nothing it stored earlier: every file is read back from storage and hashed again, the np1
// hash is recomputed from the stored data, and the facts and the media are checked again against the
// database clock. Refuses with typed errors that carry ids and states only.

export interface PublicableDeps {
  db: Db;
  storage: Storage;
}

/** States a piece can be published from: `aprobada` (scheduling) and `programada` (the scheduled send). */
export const ESTADOS_PUBLICABLES = ['aprobada', 'programada'] as const;

export interface PiezaPublicable {
  produccionId: string;
  version: number;
  /** The approved piece hash, lower-case hex. */
  hashPieza: string;
}

interface ProduccionBruta {
  id: string;
  guion_id: string;
  red: 'instagram' | 'facebook' | 'tiktok' | 'youtube';
  texto_publicacion: string;
  hashtags: string[];
  textos_alternativos: string[];
  ubicacion: string | null;
  hash_pieza: Buffer;
}

interface ArchivoBruto {
  orden: number;
  clave_almacenamiento: string;
  tamano_bytes: string;
  sha256: Buffer;
  media_id: string;
}

export async function assertPublicable(deps: PublicableDeps, clienteId: ClienteId, piezaId: string): Promise<PiezaPublicable> {
  const { db, storage } = deps;
  const pieza = await getPieza(db, clienteId, piezaId, { includeDescartados: true });
  if (!pieza) throw new PiezaNotFoundError();
  if (pieza.plan_estado !== 'aprobado' || !(ESTADOS_PUBLICABLES as readonly string[]).includes(pieza.estado)) {
    throw new PiezaNoPublicableError(pieza.estado, pieza.plan_estado);
  }

  // 1. The records say "approved" for the current production.
  const actual = await getProduccionActualBasica(db, clienteId, piezaId);
  if (!actual) throw new SinAprobacionVigenteError('sin_produccion');
  const registros = await listRegistros(db, clienteId, piezaId);
  const estado = estadoAprobacion(actual, registros);
  if (estado.estado !== 'aprobada') throw new SinAprobacionVigenteError(estado.estado);
  const aprobado = registros.find((r) => BigInt(r.seq) === estado.clienteSeq)!;

  // 2. The stored data of that production, as it is now.
  const { rows: prodRows } = await db.query<ProduccionBruta>(
    `SELECT id, guion_id, red, texto_publicacion, hashtags, textos_alternativos, ubicacion, hash_pieza
     FROM producciones WHERE id = $1 AND cliente_id = $2`,
    [actual.id, clienteId],
  );
  const produccion = prodRows[0]!;
  const { rows: archivos } = await db.query<ArchivoBruto>(
    `SELECT orden, clave_almacenamiento, tamano_bytes::text AS tamano_bytes, sha256, media_id
     FROM producciones_archivos WHERE produccion_id = $1 AND cliente_id = $2 ORDER BY orden`,
    [actual.id, clienteId],
  );
  const { rows: fuentes } = await db.query<{ media_id: string }>(
    'SELECT media_id FROM producciones_fuentes WHERE produccion_id = $1 AND cliente_id = $2',
    [actual.id, clienteId],
  );
  const { rows: hechos } = await db.query<{ hecho_id: string }>(
    'SELECT hecho_id FROM guiones_hechos WHERE guion_id = $1 AND cliente_id = $2',
    [produccion.guion_id, clienteId],
  );

  // 3. Every file is read back and hashed again. The temporary folder is always removed.
  const dir = await mkdtemp(path.join(tmpdir(), 'novaciel-publicable-'));
  const recalculados: Buffer[] = [];
  try {
    for (const archivo of archivos) {
      const destino = path.join(dir, `archivo-${archivo.orden}`);
      try {
        await storage.getFile(archivo.clave_almacenamiento, destino);
      } catch {
        throw new ArchivoAlteradoError(archivo.orden, 'ausente');
      }
      const { sha256, size } = await hashFile(destino);
      if (size !== Number(archivo.tamano_bytes)) throw new ArchivoAlteradoError(archivo.orden, 'tamano');
      if (!sha256.equals(archivo.sha256)) throw new ArchivoAlteradoError(archivo.orden, 'sha256');
      recalculados.push(sha256);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 4. The np1 hash, recomputed from what is stored now, equals the stored hash and the approved one.
  const recalculado = computePieceHash({
    red: produccion.red,
    archivos: recalculados,
    textoPublicacion: produccion.texto_publicacion,
    hashtags: produccion.hashtags,
    textosAlternativos: produccion.textos_alternativos,
    ubicacion: produccion.ubicacion,
  });
  if (!recalculado.equals(produccion.hash_pieza)) throw new HashPiezaNoCoincideError(produccion.id, 'almacenado');
  if (!recalculado.equals(Buffer.from(aprobado.hashPieza))) throw new HashPiezaNoCoincideError(produccion.id, 'aprobado');

  // 5. Rule 2 and real media, again, at publish time.
  const mediaIds = [...new Set([...archivos.map((a) => a.media_id), ...fuentes.map((f) => f.media_id)])];
  await verificarMediaYHechos(db, clienteId, mediaIds, hechos.map((h) => h.hecho_id), pieza.fecha_hora, false);

  return { produccionId: produccion.id, version: actual.version, hashPieza: recalculado.toString('hex') };
}
