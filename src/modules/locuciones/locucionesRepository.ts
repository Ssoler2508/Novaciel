import type { Db } from '../../db/types.js';
import { usdToMicro, type MicroUsd } from '../presupuesto/money.js';
import type { ClienteId } from '../shared/clienteId.js';
import type { AlineacionCaracteres } from './alineacion.js';
import type { AjustesVoz } from './claveCache.js';

// Queries of `locuciones`. EVERY query filters by cliente_id. The table is append-only: there is no update.

export interface Locucion {
  id: string;
  clienteId: ClienteId;
  guionId: string;
  escena: number;
  claveCache: string;
  claveAlmacenamiento: string;
  formato: string;
  duracionMs: number;
  caracteres: number;
  alineacion: AlineacionCaracteres;
  proveedor: string;
  modeloId: string;
  vozId: string;
  ajustes: AjustesVoz;
  costoReal: MicroUsd;
  autorizacionId: string | null;
  creadoEn: Date;
}

interface Row {
  id: string;
  cliente_id: string;
  guion_id: string;
  escena: number;
  clave_cache: string;
  clave_almacenamiento: string;
  formato: string;
  duracion_ms: number;
  caracteres: number;
  alineacion: { caracteres: string[]; inicio_ms: number[]; fin_ms: number[] };
  proveedor: string;
  modelo_id: string;
  voz_id: string;
  ajustes: AjustesVoz;
  costo_real: string;
  autorizacion_id: string | null;
  creado_en: Date;
}

const COLUMNS = `id, cliente_id, guion_id, escena, clave_cache, clave_almacenamiento, formato, duracion_ms, caracteres,
  alineacion, proveedor, modelo_id, voz_id, ajustes, costo_real::text AS costo_real, autorizacion_id, creado_en`;

function toLocucion(row: Row): Locucion {
  return {
    id: row.id,
    clienteId: row.cliente_id as ClienteId,
    guionId: row.guion_id,
    escena: row.escena,
    claveCache: row.clave_cache,
    claveAlmacenamiento: row.clave_almacenamiento,
    formato: row.formato,
    duracionMs: row.duracion_ms,
    caracteres: row.caracteres,
    alineacion: { caracteres: row.alineacion.caracteres, inicioMs: row.alineacion.inicio_ms, finMs: row.alineacion.fin_ms },
    proveedor: row.proveedor,
    modeloId: row.modelo_id,
    vozId: row.voz_id,
    ajustes: row.ajustes,
    costoReal: usdToMicro(row.costo_real),
    autorizacionId: row.autorizacion_id,
    creadoEn: row.creado_en,
  };
}

/** The voice-over with that cache key for this client, or null. */
export async function findLocucionByClave(db: Db, clienteId: ClienteId, claveCache: string): Promise<Locucion | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM locuciones WHERE cliente_id = $1 AND clave_cache = $2`, [clienteId, claveCache]);
  return rows[0] ? toLocucion(rows[0]) : null;
}

export async function getLocucion(db: Db, clienteId: ClienteId, id: string): Promise<Locucion | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM locuciones WHERE cliente_id = $1 AND id = $2`, [clienteId, id]);
  return rows[0] ? toLocucion(rows[0]) : null;
}

/** True when the brief belongs to the client. */
export async function guionPerteneceAlCliente(db: Db, clienteId: ClienteId, guionId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM guiones WHERE id = $1 AND cliente_id = $2', [guionId, clienteId]);
  return rows.length > 0;
}

export interface NuevaLocucion {
  clienteId: ClienteId;
  guionId: string;
  escena: number;
  claveCache: string;
  claveAlmacenamiento: string;
  formato: string;
  duracionMs: number;
  caracteres: number;
  alineacion: AlineacionCaracteres;
  proveedor: string;
  modeloId: string;
  vozId: string;
  ajustes: AjustesVoz;
  costoReal: string;
  autorizacionId: string;
}

/**
 * Inserts the voice-over; when the cache key already exists for the client (a concurrent call won), the
 * existing row is returned and `creada` is false. Never overwrites.
 */
export async function insertLocucion(db: Db, n: NuevaLocucion): Promise<{ locucion: Locucion; creada: boolean }> {
  const { rows } = await db.query<Row>(
    `INSERT INTO locuciones
       (cliente_id, guion_id, escena, clave_cache, clave_almacenamiento, formato, duracion_ms, caracteres, alineacion,
        proveedor, modelo_id, voz_id, ajustes, costo_real, autorizacion_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (cliente_id, clave_cache) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      n.clienteId,
      n.guionId,
      n.escena,
      n.claveCache,
      n.claveAlmacenamiento,
      n.formato,
      n.duracionMs,
      n.caracteres,
      JSON.stringify({ caracteres: n.alineacion.caracteres, inicio_ms: n.alineacion.inicioMs, fin_ms: n.alineacion.finMs }),
      n.proveedor,
      n.modeloId,
      n.vozId,
      JSON.stringify(n.ajustes),
      n.costoReal,
      n.autorizacionId,
    ],
  );
  if (rows[0]) return { locucion: toLocucion(rows[0]), creada: true };
  const existing = await findLocucionByClave(db, n.clienteId, n.claveCache);
  if (!existing) throw new Error('The voice-over insert was skipped but no row exists');
  return { locucion: existing, creada: false };
}

/** The scenes of a production that have a voice-over record, in order. */
export async function listEscenasConVoz(db: Db, clienteId: ClienteId, produccionId: string): Promise<number[]> {
  const { rows } = await db.query<{ escena: number }>('SELECT escena FROM producciones_locuciones WHERE cliente_id = $1 AND produccion_id = $2 ORDER BY escena', [clienteId, produccionId]);
  return rows.map((r) => r.escena);
}

/**
 * Why the production was made without its voice (`sin_plantilla`, `sin_texto`...), read from the audit row that
 * created it, or null when the voice was used or never configured. A closed identifier, never text.
 */
export async function vozOmitidaDeProduccion(db: Db, clienteId: ClienteId, produccionId: string): Promise<string | null> {
  const { rows } = await db.query<{ motivo: string | null }>(
    `SELECT datos_despues->>'voz_omitida' AS motivo FROM auditoria
     WHERE cliente_id = $1 AND tabla = 'producciones' AND accion = 'crear' AND fila_id::text = $2
     ORDER BY id DESC LIMIT 1`,
    [clienteId, produccionId],
  );
  const motivo = rows[0]?.motivo ?? null;
  return motivo !== null && /^[a-z_]{1,40}$/.test(motivo) ? motivo : null;
}
