import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';
import type { CategoriaError } from './politicaReintentos.js';

// Reads and the two inserts of the publishing records (append-only tables of migration 1700000002600).
// Every query filters by cliente_id. The attempt number always comes from these rows.

export type Red = 'instagram' | 'facebook' | 'tiktok' | 'youtube';
export type EstadoResultado = 'publicada' | 'fallida' | 'desconocida';

export interface IntentoView {
  id: string;
  seq: string;
  produccion_id: string;
  numero_intento: number;
  clave_idempotencia: string;
  conexion_id: string;
  etiqueta_ia: boolean;
  creado_en: Date;
  proveedor: string;
  red: Red;
  /** The latest result of the attempt; null while it has none ("enviando"). */
  resultado: EstadoResultado | null;
  resultado_en: Date | null;
  id_externo: string | null;
  enlace: string | null;
  categoria_error: CategoriaError | null;
}

const INTENTO_COLUMNS = `p.id, p.seq::text AS seq, p.produccion_id, p.numero_intento, p.clave_idempotencia, p.conexion_id, p.etiqueta_ia, p.creado_en,
  p.proveedor, p.red, r.estado AS resultado, r.creado_en AS resultado_en, r.id_externo, r.enlace, r.categoria_error`;
const INTENTO_FROM = `FROM publicaciones p
  LEFT JOIN LATERAL (
    SELECT r.estado, r.creado_en, r.id_externo, r.enlace, r.categoria_error FROM publicaciones_resultados r
    WHERE r.publicacion_id = p.id AND r.cliente_id = p.cliente_id ORDER BY r.seq DESC LIMIT 1
  ) r ON true`;

/** The latest attempt of a production, with its latest result, or null when none was made. */
export async function getUltimoIntento(db: Db, clienteId: ClienteId, produccionId: string): Promise<IntentoView | null> {
  const { rows } = await db.query<IntentoView>(
    `SELECT ${INTENTO_COLUMNS} ${INTENTO_FROM} WHERE p.cliente_id = $1 AND p.produccion_id = $2 ORDER BY p.numero_intento DESC LIMIT 1`,
    [clienteId, produccionId],
  );
  return rows[0] ?? null;
}

/** Every attempt of a piece, oldest first, each with its latest result. */
export async function listIntentosDePieza(db: Db, clienteId: ClienteId, piezaId: string): Promise<IntentoView[]> {
  const { rows } = await db.query<IntentoView>(
    `SELECT ${INTENTO_COLUMNS} ${INTENTO_FROM} WHERE p.cliente_id = $1 AND p.pieza_id = $2 ORDER BY p.seq`,
    [clienteId, piezaId],
  );
  return rows;
}

export interface NuevoIntento {
  piezaId: string;
  produccionId: string;
  produccionVersion: number;
  hashPieza: Buffer;
  conexionId: string;
  red: Red;
  proveedor: string;
  claveIdempotencia: string;
  numeroIntento: number;
  etiquetaIa: boolean;
  actorUsuarioId: string | null;
}

/** Inserts an attempt. The database trigger refuses anything that is not the exact current production. */
export async function insertIntento(db: Db, clienteId: ClienteId, n: NuevoIntento): Promise<IntentoView> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO publicaciones
       (cliente_id, pieza_id, produccion_id, produccion_version, hash_version, hash_pieza, conexion_id, red, proveedor,
        clave_idempotencia, numero_intento, etiqueta_ia, actor_tipo, actor_usuario_id)
     VALUES ($1, $2, $3, $4, 'np1', $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      clienteId,
      n.piezaId,
      n.produccionId,
      n.produccionVersion,
      n.hashPieza,
      n.conexionId,
      n.red,
      n.proveedor,
      n.claveIdempotencia,
      n.numeroIntento,
      n.etiquetaIa,
      n.actorUsuarioId ? 'usuario' : 'sistema',
      n.actorUsuarioId,
    ],
  );
  const { rows: vistas } = await db.query<IntentoView>(`SELECT ${INTENTO_COLUMNS} ${INTENTO_FROM} WHERE p.id = $1 AND p.cliente_id = $2`, [rows[0]!.id, clienteId]);
  return vistas[0]!;
}

export type NuevoResultado =
  | { estado: 'publicada'; idExterno: string; enlace: string | null }
  | { estado: 'fallida' | 'desconocida'; categoria: CategoriaError };

export async function insertResultado(
  db: Db,
  clienteId: ClienteId,
  intento: { id: string; piezaId: string; produccionId: string },
  r: NuevoResultado,
  actorUsuarioId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO publicaciones_resultados
       (cliente_id, publicacion_id, pieza_id, produccion_id, estado, id_externo, enlace, categoria_error, actor_tipo, actor_usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      clienteId,
      intento.id,
      intento.piezaId,
      intento.produccionId,
      r.estado,
      r.estado === 'publicada' ? r.idExterno : null,
      r.estado === 'publicada' ? r.enlace : null,
      r.estado === 'publicada' ? null : r.categoria,
      actorUsuarioId ? 'usuario' : 'sistema',
      actorUsuarioId,
    ],
  );
}

export interface ProduccionParaEnvio {
  id: string;
  version: number;
  red: Red;
  hashPieza: Buffer;
  textoPublicacion: string;
  hashtags: string[];
  textosAlternativos: string[];
  ubicacion: string | null;
  archivos: { orden: number; claveAlmacenamiento: string; mime: string; tamanoBytes: number; sha256: Buffer }[];
}

/** The stored content of the CURRENT production of a piece (what is sent), or null. */
export async function getProduccionParaEnvio(db: Db, clienteId: ClienteId, piezaId: string): Promise<ProduccionParaEnvio | null> {
  const { rows } = await db.query<{
    id: string;
    version: number;
    red: Red;
    hash_pieza: Buffer;
    texto_publicacion: string;
    hashtags: string[];
    textos_alternativos: string[];
    ubicacion: string | null;
  }>(
    `SELECT id, version, red, hash_pieza, texto_publicacion, hashtags, textos_alternativos, ubicacion
     FROM producciones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual`,
    [piezaId, clienteId],
  );
  const p = rows[0];
  if (!p) return null;
  const { rows: archivos } = await db.query<{ orden: number; clave_almacenamiento: string; mime: string; tamano_bytes: string; sha256: Buffer }>(
    `SELECT orden, clave_almacenamiento, mime, tamano_bytes::text AS tamano_bytes, sha256
     FROM producciones_archivos WHERE produccion_id = $1 AND cliente_id = $2 ORDER BY orden`,
    [p.id, clienteId],
  );
  return {
    id: p.id,
    version: p.version,
    red: p.red,
    hashPieza: p.hash_pieza,
    textoPublicacion: p.texto_publicacion,
    hashtags: p.hashtags,
    textosAlternativos: p.textos_alternativos,
    ubicacion: p.ubicacion,
    archivos: archivos.map((a) => ({
      orden: a.orden,
      claveAlmacenamiento: a.clave_almacenamiento,
      mime: a.mime,
      tamanoBytes: Number(a.tamano_bytes),
      sha256: a.sha256,
    })),
  };
}

export interface ConexionActiva {
  id: string;
  etiqueta: string;
  expira_en: Date | null;
}

/** The active (not revoked) connection of the client for a network, or null. */
export async function getConexionActiva(db: Db, clienteId: ClienteId, red: Red): Promise<ConexionActiva | null> {
  const { rows } = await db.query<ConexionActiva>(
    'SELECT id, etiqueta, expira_en FROM conexiones_redes WHERE cliente_id = $1 AND red = $2 AND revocada_en IS NULL',
    [clienteId, red],
  );
  return rows[0] ?? null;
}
