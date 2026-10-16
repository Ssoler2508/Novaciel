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
  /** The final files, in order (orden 1, 2, ...). Defaults to one file; [] inserts none. */
  archivos?: ArchivoInput[];
}

export async function createProduccionArchivo(
  db: Db,
  params: { produccionId: string; clienteId: string; orden: number } & ArchivoInput,
): Promise<ProduccionArchivoRow> {
  const mime = params.mime ?? 'image/jpeg';
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4' }[mime] ?? 'jpg';
  const mediaId = params.mediaId ?? (await createMedia(db, { clienteId: params.clienteId, tipo: 'foto' })).id;
  const { rows } = await db.query<ProduccionArchivoRow>(
    `INSERT INTO producciones_archivos
       (produccion_id, cliente_id, orden, clave_almacenamiento, mime, ancho, alto, tamano_bytes, sha256, media_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      params.produccionId,
      params.clienteId,
      params.orden,
      params.claveAlmacenamiento ?? `${params.clienteId}/producidos/${randomUUID()}.${ext}`,
      mime,
      params.ancho ?? 1080,
      params.alto ?? 1350,
      params.tamanoBytes ?? 2048,
      params.sha256 ?? randomBytes(32),
      mediaId,
    ],
  );
  return rows[0]!;
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
  const guionId =
    overrides.guionId ??
    (await db.query<{ id: string }>('SELECT id FROM guiones WHERE pieza_id = $1 AND es_actual', [piezaId])).rows[0]!.id;

  const last = (await db.query<{ n: number }>('SELECT COALESCE(max(version), 0)::int AS n FROM producciones WHERE pieza_id = $1', [piezaId])).rows[0]!.n;
  await db.query('UPDATE producciones SET es_actual = false WHERE pieza_id = $1 AND es_actual', [piezaId]);
  const archivos = overrides.archivos ?? [{}];
  const { rows } = await db.query<ProduccionRow>(
    `INSERT INTO producciones
       (cliente_id, pieza_id, guion_id, version, es_actual, red, texto_publicacion, hashtags, textos_alternativos, ubicacion, hash_version, hash_pieza, creado_por)
     VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
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
