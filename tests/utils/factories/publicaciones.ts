import type { Db } from '../../../src/db/types.js';
import { createConexionRed } from './conexionesRedes.js';
import { uniqueSuffix } from './unique.js';

// Plain SQL, no audit: it goes through the database triggers, which is what these tables are about. An
// attempt is about the piece's CURRENT production unless an override says otherwise, so a test can build a
// forged one on purpose. The piece must be `programada` (the trigger checks it).

export interface PublicacionRow {
  id: string;
  seq: string;
  cliente_id: string;
  pieza_id: string;
  produccion_id: string;
  produccion_version: number;
  hash_version: string;
  hash_pieza: Buffer;
  conexion_id: string;
  red: string;
  proveedor: string;
  clave_idempotencia: string;
  numero_intento: number;
  etiqueta_ia: boolean;
  actor_tipo: 'usuario' | 'sistema';
  actor_usuario_id: string | null;
  creado_en: Date;
}

export interface PublicacionOverrides {
  piezaId: string;
  /** Defaults to the piece's current production. */
  produccionId?: string;
  produccionVersion?: number;
  hashVersion?: string;
  hashPieza?: Buffer;
  conexionId?: string;
  red?: string;
  proveedor?: string;
  claveIdempotencia?: string;
  /** Defaults to the next number after the production's last attempt. */
  numeroIntento?: number;
  etiquetaIa?: boolean;
  actorUsuarioId?: string | null;
}

export async function createPublicacion(db: Db, o: PublicacionOverrides): Promise<PublicacionRow> {
  const pieza = (await db.query<{ cliente_id: string }>('SELECT cliente_id FROM piezas WHERE id = $1', [o.piezaId])).rows[0]!;
  const current = (
    await db.query<{ id: string; version: number; hash_version: string; hash_pieza: Buffer; red: string }>(
      'SELECT id, version, hash_version, hash_pieza, red FROM producciones WHERE pieza_id = $1 AND es_actual',
      [o.piezaId],
    )
  ).rows[0]!;
  const produccionId = o.produccionId ?? current.id;
  const red = o.red ?? current.red;
  const conexionId =
    o.conexionId ??
    (
      await db.query<{ id: string }>('SELECT id FROM conexiones_redes WHERE cliente_id = $1 AND red = $2 AND revocada_en IS NULL', [pieza.cliente_id, red])
    ).rows[0]?.id ??
    (await createConexionRed(db, { clienteId: pieza.cliente_id, red })).id;
  const previo = (
    await db.query<{ numero_intento: number; clave_idempotencia: string }>(
      'SELECT numero_intento, clave_idempotencia FROM publicaciones WHERE produccion_id = $1 ORDER BY numero_intento DESC LIMIT 1',
      [produccionId],
    )
  ).rows[0];
  const { rows } = await db.query<PublicacionRow>(
    `INSERT INTO publicaciones
       (cliente_id, pieza_id, produccion_id, produccion_version, hash_version, hash_pieza, conexion_id, red, proveedor,
        clave_idempotencia, numero_intento, etiqueta_ia, actor_tipo, actor_usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      pieza.cliente_id,
      o.piezaId,
      produccionId,
      o.produccionVersion ?? current.version,
      o.hashVersion ?? current.hash_version,
      o.hashPieza ?? current.hash_pieza,
      conexionId,
      red,
      o.proveedor ?? 'fake',
      o.claveIdempotencia ?? previo?.clave_idempotencia ?? `test:${uniqueSuffix()}`,
      o.numeroIntento ?? (previo ? previo.numero_intento + 1 : 1),
      o.etiquetaIa ?? false,
      o.actorUsuarioId ? 'usuario' : 'sistema',
      o.actorUsuarioId ?? null,
    ],
  );
  return rows[0]!;
}

export interface PublicacionResultadoRow {
  id: string;
  seq: string;
  cliente_id: string;
  publicacion_id: string;
  pieza_id: string;
  produccion_id: string;
  estado: 'publicada' | 'fallida' | 'desconocida';
  id_externo: string | null;
  enlace: string | null;
  categoria_error: string | null;
  actor_tipo: 'usuario' | 'sistema';
  actor_usuario_id: string | null;
  creado_en: Date;
}

export interface PublicacionResultadoOverrides {
  publicacionId: string;
  /** Default 'publicada'. */
  estado?: PublicacionResultadoRow['estado'];
  idExterno?: string;
  enlace?: string | null;
  /** Default 'server' for a failed result and 'resultado_desconocido' for an unknown one. */
  categoriaError?: string;
  actorUsuarioId?: string | null;
}

export async function createPublicacionResultado(db: Db, o: PublicacionResultadoOverrides): Promise<PublicacionResultadoRow> {
  const intento = (
    await db.query<{ cliente_id: string; pieza_id: string; produccion_id: string }>(
      'SELECT cliente_id, pieza_id, produccion_id FROM publicaciones WHERE id = $1',
      [o.publicacionId],
    )
  ).rows[0]!;
  const estado = o.estado ?? 'publicada';
  const publicada = estado === 'publicada';
  const { rows } = await db.query<PublicacionResultadoRow>(
    `INSERT INTO publicaciones_resultados
       (cliente_id, publicacion_id, pieza_id, produccion_id, estado, id_externo, enlace, categoria_error, actor_tipo, actor_usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      intento.cliente_id,
      o.publicacionId,
      intento.pieza_id,
      intento.produccion_id,
      estado,
      publicada ? (o.idExterno ?? `ext-${uniqueSuffix()}`) : null,
      publicada ? (o.enlace === undefined ? `https://example.test/p/${uniqueSuffix()}` : o.enlace) : null,
      publicada ? null : (o.categoriaError ?? (estado === 'desconocida' ? 'resultado_desconocido' : 'server')),
      o.actorUsuarioId ? 'usuario' : 'sistema',
      o.actorUsuarioId ?? null,
    ],
  );
  return rows[0]!;
}

export interface MetricaPiezaRow {
  id: string;
  cliente_id: string;
  publicacion_id: string;
  ventana: '24h' | '72h' | '7d' | '28d';
  recogida_en: Date;
  impresiones: string | null;
  alcance: string | null;
  reproducciones: string | null;
  me_gusta: string | null;
  comentarios: string | null;
  compartidos: string | null;
  guardados: string | null;
  tiempo_reproduccion_promedio_seg: string | null;
  retencion_pct: string | null;
  visitas_perfil: string | null;
  clics_enlace: string | null;
  seguidores_ganados: string | null;
}

export async function createMetricaPieza(
  db: Db,
  o: { publicacionId: string; ventana?: MetricaPiezaRow['ventana']; alcance?: number | null; meGusta?: number | null },
): Promise<MetricaPiezaRow> {
  const cliente = (await db.query<{ cliente_id: string }>('SELECT cliente_id FROM publicaciones WHERE id = $1', [o.publicacionId])).rows[0]!;
  const { rows } = await db.query<MetricaPiezaRow>(
    `INSERT INTO metricas_pieza (cliente_id, publicacion_id, ventana, alcance, me_gusta) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [cliente.cliente_id, o.publicacionId, o.ventana ?? '24h', o.alcance === undefined ? 120 : o.alcance, o.meGusta === undefined ? 7 : o.meGusta],
  );
  return rows[0]!;
}
