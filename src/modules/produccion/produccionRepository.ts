import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';

// Reads of productions (producciones) with their files (producciones_archivos). Every query filters by
// cliente_id. Hashes are shown as lower-case hex. Signed URLs for the files are made by the routes.

/** The clip and the stretch of it behind one scene of a reel's video file. */
export interface FuenteView {
  escena: number;
  media_id: string;
  entrada_ms: number;
  salida_ms: number;
}

export interface ArchivoView {
  orden: number;
  clave_almacenamiento: string;
  mime: string;
  ancho: number;
  alto: number;
  tamano_bytes: number;
  /** SHA-256 of the file, lower-case hex. */
  sha256: string;
  /** The client's real media the file was made from (for a reel, the clip of its first scene). */
  media_id: string;
  /** Videos only (null for an image). */
  duracion_ms: number | null;
  fps: number | null;
  codec_video: string | null;
  codec_audio: string | null;
  /** Every clip behind a video file, scene by scene. Empty for an image. */
  fuentes: FuenteView[];
}

export interface ProduccionView {
  id: string;
  cliente_id: ClienteId;
  pieza_id: string;
  guion_id: string;
  version: number;
  es_actual: boolean;
  red: 'instagram' | 'facebook' | 'tiktok' | 'youtube';
  texto_publicacion: string;
  hashtags: string[];
  textos_alternativos: string[];
  ubicacion: string | null;
  hash_version: string;
  /** The piece-level hash, lower-case hex. */
  hash_pieza: string;
  /** The animated template the reel's text was drawn with; null for images and for reels made with PNG overlays. */
  plantilla: string | null;
  plantilla_version: number | null;
  archivos: ArchivoView[];
  creado_por: string | null;
  creado_en: Date;
}

export interface ProduccionReadOptions {
  /** Productions of a discarded plan are hidden by default, like its pieces. */
  includeDescartados?: boolean;
}

interface ProduccionRow extends Omit<ProduccionView, 'archivos' | 'hash_pieza'> {
  hash_pieza: string;
}

async function loadViews(db: Db, clienteId: ClienteId, piezaId: string, soloActual: boolean, options: ProduccionReadOptions): Promise<ProduccionView[]> {
  const { rows } = await db.query<ProduccionRow>(
    `SELECT x.id, x.cliente_id, x.pieza_id, x.guion_id, x.version, x.es_actual, x.red, x.texto_publicacion, x.hashtags,
            x.textos_alternativos, x.ubicacion, x.hash_version, encode(x.hash_pieza, 'hex') AS hash_pieza, x.plantilla, x.plantilla_version, x.creado_por, x.creado_en
     FROM producciones x
     JOIN piezas p ON p.id = x.pieza_id AND p.cliente_id = x.cliente_id
     JOIN planes_semanales pl ON pl.id = p.plan_id AND pl.cliente_id = p.cliente_id
     WHERE x.cliente_id = $1 AND x.pieza_id = $2 AND ($3::boolean OR x.es_actual) AND ($4::boolean OR pl.estado <> 'descartado')
     ORDER BY x.version`,
    [clienteId, piezaId, !soloActual, options.includeDescartados ?? false],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const { rows: archivos } = await db.query<Omit<ArchivoView, 'fuentes'> & { produccion_id: string; tamano_bytes: string }>(
    `SELECT produccion_id, orden, clave_almacenamiento, mime, ancho, alto, tamano_bytes::text AS tamano_bytes,
            encode(sha256, 'hex') AS sha256, media_id, duracion_ms, fps::float8 AS fps, codec_video, codec_audio
     FROM producciones_archivos WHERE cliente_id = $1 AND produccion_id = ANY($2::uuid[]) ORDER BY produccion_id, orden`,
    [clienteId, ids],
  );
  const { rows: fuentes } = await db.query<FuenteView & { produccion_id: string; orden_archivo: number }>(
    `SELECT produccion_id, orden_archivo, escena, media_id, entrada_ms, salida_ms
     FROM producciones_fuentes WHERE cliente_id = $1 AND produccion_id = ANY($2::uuid[]) ORDER BY produccion_id, orden_archivo, escena`,
    [clienteId, ids],
  );
  return rows.map((row) => ({
    ...row,
    archivos: archivos
      .filter((a) => a.produccion_id === row.id)
      .map(({ produccion_id: _produccion, tamano_bytes, ...archivo }) => ({
        ...archivo,
        tamano_bytes: Number(tamano_bytes),
        fuentes: fuentes
          .filter((f) => f.produccion_id === row.id && f.orden_archivo === archivo.orden)
          .map(({ produccion_id: _p, orden_archivo: _o, ...fuente }) => fuente),
      })),
  }));
}

/** The current production of a piece of this client, or null (also for another client's piece). */
export async function getProduccionActual(db: Db, clienteId: ClienteId, piezaId: string, options: ProduccionReadOptions = {}): Promise<ProduccionView | null> {
  return (await loadViews(db, clienteId, piezaId, true, options))[0] ?? null;
}

/** Every version of a piece's production, oldest first. Empty for another client's piece. */
export function listProduccionVersions(db: Db, clienteId: ClienteId, piezaId: string, options: ProduccionReadOptions = {}): Promise<ProduccionView[]> {
  return loadViews(db, clienteId, piezaId, false, options);
}
