import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../../../src/db/types.js';
import { createGuion } from './guiones.js';
import { createMedia } from './media.js';
import { moverPieza } from './planesPiezas.js';

// Plain SQL, no audit: they go through the database triggers like the real service will. The piece
// hash stored here is a random placeholder: the real computation (computePieceHash) is tested where
// it is implemented; these rows only exercise the schema.

export interface ProduccionRow {
  id: string;
  cliente_id: string;
  pieza_id: string;
  guion_id: string;
  version: number;
  es_actual: boolean;
  red: string;
  texto_publicacion: string;
  hashtags: string[];
  textos_alternativos: string[];
  ubicacion: string | null;
  hash_version: string;
  hash_pieza: Buffer;
  /** The animated text template (Step 7c), or null. */
  plantilla: string | null;
  plantilla_version: number | null;
  /** The brand profile version the files were rendered with (Step 8); null only for old rows. */
  perfil_marca_id: string | null;
  creado_por: string | null;
  creado_en: Date;
}

export interface ProduccionArchivoRow {
  produccion_id: string;
  cliente_id: string;
  orden: number;
  clave_almacenamiento: string;
  mime: string;
  ancho: number;
  alto: number;
  tamano_bytes: string;
  sha256: Buffer;
  media_id: string;
  creado_en: Date;
  duracion_ms: number | null;
  fps: string | null;
  codec_video: string | null;
  codec_audio: string | null;
}

export interface ProduccionFuenteRow {
  produccion_id: string;
  cliente_id: string;
  orden_archivo: number;
  escena: number;
  media_id: string;
  entrada_ms: number;
  salida_ms: number;
  creado_en: Date;
}

export interface FuenteInput {
  /** Defaults to the media of the file (the clip of the first scene). */
  mediaId?: string;
  entradaMs?: number;
  salidaMs?: number;
}

export interface ArchivoInput {
  /** Defaults to a new photo of the client. */
  mediaId?: string;
  claveAlmacenamiento?: string;
  mime?: string;
  ancho?: number;
  alto?: number;
  tamanoBytes?: number;
  sha256?: Buffer;
  /**
   * Video files (mime video/mp4) default to 20 s, 30 fps, h264 and aac; an image has none of these.
   * Pass a value to build a combination the database must refuse.
   */
  duracionMs?: number | null;
  fps?: number | null;
  codecVideo?: string | null;
  codecAudio?: string | null;
  /**
   * The clips of a video file, scene 1 to n. A video defaults to one scene (the file's media);
   * [] inserts none. Ignored for images.
   */
  fuentes?: FuenteInput[];
}

export interface ProduccionOverrides {
  clienteId?: string;
  /**
   * An existing piece. When omitted, the factory builds an approved plan with a piece and its brief,
   * and moves the piece to guion_listo, the state a first production starts from.
   */
  piezaId?: string;
  /** Defaults to the piece's current brief. */
  guionId?: string;
  /** The profile version the production was rendered with. Defaults to the one of the brief. */
  perfilMarcaId?: string;
  /** Defaults to the next version of the piece. */
  version?: number;
  /**
   * Defaults to true. A previous current production of the piece is retired first, like the service
   * does. false inserts it current (a production is born current) and retires it right after.
   */
  esActual?: boolean;
  /** Defaults to the piece's network. */
  red?: string;
  textoPublicacion?: string;
  hashtags?: string[];
  /** Defaults to one alt text per file. */
  textosAlternativos?: string[];
  ubicacion?: string | null;
  hashVersion?: string;
  hashPieza?: Buffer;
  creadoPor?: string | null;
  /** The animated text template and its version (both or neither). */
  plantilla?: string | null;
  plantillaVersion?: number | null;
  /** The final files, in order (orden 1, 2, ...). Defaults to one file; [] inserts none. */
  archivos?: ArchivoInput[];
}

export async function createProduccionFuente(
  db: Db,
  params: { produccionId: string; clienteId: string; ordenArchivo: number; escena: number; mediaId: string } & Omit<FuenteInput, 'mediaId'>,
): Promise<ProduccionFuenteRow> {
  const { rows } = await db.query<ProduccionFuenteRow>(
    `INSERT INTO producciones_fuentes (produccion_id, cliente_id, orden_archivo, escena, media_id, entrada_ms, salida_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [params.produccionId, params.clienteId, params.ordenArchivo, params.escena, params.mediaId, params.entradaMs ?? 0, params.salidaMs ?? 3000],
  );
  return rows[0]!;
}

export async function createProduccionArchivo(
  db: Db,
  params: { produccionId: string; clienteId: string; orden: number } & ArchivoInput,
): Promise<ProduccionArchivoRow> {
  const mime = params.mime ?? 'image/jpeg';
  const esVideo = mime === 'video/mp4';
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' }[mime] ?? 'jpg';
  const mediaId = params.mediaId ?? (await createMedia(db, { clienteId: params.clienteId, tipo: esVideo ? 'video' : 'foto' })).id;
  const ficha = <T>(value: T | null | undefined, porDefecto: T): T | null => (value !== undefined ? value : esVideo ? porDefecto : null);
  const { rows } = await db.query<ProduccionArchivoRow>(
    `INSERT INTO producciones_archivos
       (produccion_id, cliente_id, orden, clave_almacenamiento, mime, ancho, alto, tamano_bytes, sha256, media_id,
        duracion_ms, fps, codec_video, codec_audio)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [
      params.produccionId,
      params.clienteId,
      params.orden,
      params.claveAlmacenamiento ?? `${params.clienteId}/producidos/${randomUUID()}.${ext}`,
      mime,
      params.ancho ?? 1080,
      params.alto ?? (esVideo ? 1920 : 1350),
      params.tamanoBytes ?? 2048,
      params.sha256 ?? randomBytes(32),
      mediaId,
      ficha(params.duracionMs, 20_000),
      ficha(params.fps, 30),
      ficha(params.codecVideo, 'h264'),
      ficha(params.codecAudio, 'aac'),
    ],
  );
  const archivo = rows[0]!;
  if (esVideo) {
    const fuentes = params.fuentes ?? [{}];
    for (const [i, fuente] of fuentes.entries()) {
      await createProduccionFuente(db, {
        produccionId: params.produccionId,
        clienteId: params.clienteId,
        ordenArchivo: params.orden,
        escena: i + 1,
        mediaId: fuente.mediaId ?? mediaId,
        ...(fuente.entradaMs !== undefined ? { entradaMs: fuente.entradaMs } : {}),
        ...(fuente.salidaMs !== undefined ? { salidaMs: fuente.salidaMs } : {}),
      });
    }
  }
  return archivo;
}

/** Inserts a production (and its files). */
export async function createProduccion(db: Db, overrides: ProduccionOverrides = {}): Promise<ProduccionRow> {
  let piezaId = overrides.piezaId;
  let clienteId = overrides.clienteId;
  if (!piezaId) {
    const guion = await createGuion(db, { ...(clienteId ? { clienteId } : {}) });
    piezaId = guion.pieza_id;
    clienteId = guion.cliente_id;
    await moverPieza(db, piezaId, 'guion_listo');
  }
  const pieza = (await db.query<{ cliente_id: string; red: string }>('SELECT cliente_id, red FROM piezas WHERE id = $1', [piezaId])).rows[0]!;
  clienteId ??= pieza.cliente_id;
  const guion = (
    await db.query<{ id: string; perfil_marca_id: string }>(
      overrides.guionId ? 'SELECT id, perfil_marca_id FROM guiones WHERE id = $1' : 'SELECT id, perfil_marca_id FROM guiones WHERE pieza_id = $1 AND es_actual',
      [overrides.guionId ?? piezaId],
    )
  ).rows[0]!;
  const guionId = guion.id;
  const perfilMarcaId = overrides.perfilMarcaId ?? guion.perfil_marca_id;

  const last = (await db.query<{ n: number }>('SELECT COALESCE(max(version), 0)::int AS n FROM producciones WHERE pieza_id = $1', [piezaId])).rows[0]!.n;
  await db.query('UPDATE producciones SET es_actual = false WHERE pieza_id = $1 AND es_actual', [piezaId]);
  const archivos = overrides.archivos ?? [{}];
  const { rows } = await db.query<ProduccionRow>(
    `INSERT INTO producciones
       (cliente_id, pieza_id, guion_id, version, es_actual, red, texto_publicacion, hashtags, textos_alternativos, ubicacion, hash_version, hash_pieza, creado_por, plantilla, plantilla_version, perfil_marca_id)
     VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [
      clienteId,
      piezaId,
      guionId,
      overrides.version ?? last + 1,
      overrides.red ?? pieza.red,
      overrides.textoPublicacion ?? 'Texto de publicación ficticio',
      overrides.hashtags ?? ['#ficticio'],
      overrides.textosAlternativos ?? archivos.map((_a, i) => `Texto alternativo ficticio ${i + 1}`),
      overrides.ubicacion === undefined ? null : overrides.ubicacion,
      overrides.hashVersion ?? 'np1',
      overrides.hashPieza ?? randomBytes(32),
      overrides.creadoPor ?? null,
      overrides.plantilla ?? null,
      overrides.plantillaVersion ?? null,
      perfilMarcaId,
    ],
  );
  const produccion = rows[0]!;
  for (const [i, archivo] of archivos.entries()) {
    await createProduccionArchivo(db, { produccionId: produccion.id, clienteId, orden: i + 1, ...archivo });
  }
  if (overrides.esActual === false) {
    return (await db.query<ProduccionRow>('UPDATE producciones SET es_actual = false WHERE id = $1 RETURNING *', [produccion.id])).rows[0]!;
  }
  return produccion;
}
