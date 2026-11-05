import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';
import { VENTANAS, ventanasDeMedicion, type MetricasNormalizadas, type VentanaMetricas } from './normalizarMetricas.js';
import type { Red } from './publicacionesRepository.js';

// Reads and writes of the publishing jobs (Step 10, checkpoint D): the sweeps that look across clients (a
// system job must) and the metrics snapshots. Each ACTION taken from a sweep result is done per client and
// filtered by cliente_id; the sweeps return ids only.

export interface PiezaVencida {
  cliente_id: ClienteId;
  pieza_id: string;
}

/**
 * Pieces of an approved plan that still wait for an approval (`revision_novaciel`, `esperando_aprobacion`)
 * although their scheduled time has come. Oldest first.
 */
export async function listPiezasVencidasSinAprobacion(db: Db, ahora: Date, limite = 100): Promise<PiezaVencida[]> {
  const { rows } = await db.query<PiezaVencida>(
    `SELECT p.cliente_id, p.id AS pieza_id
     FROM piezas p JOIN planes_semanales pl ON pl.id = p.plan_id AND pl.cliente_id = p.cliente_id
     WHERE pl.estado = 'aprobado' AND p.estado IN ('revision_novaciel', 'esperando_aprobacion') AND p.fecha_hora <= $1
     ORDER BY p.fecha_hora, p.id LIMIT $2`,
    [ahora, limite],
  );
  return rows;
}

export interface ProgramadaVencida {
  cliente_id: ClienteId;
  pieza_id: string;
  produccion_id: string;
  fecha_hora: Date;
  /** The number of the latest attempt, or null when none was made. */
  numero_intento: number | null;
  resultado: 'publicada' | 'fallida' | 'desconocida' | null;
  resultado_en: Date | null;
}

/** `programada` pieces whose time has come, with the state of their latest attempt. */
export async function listProgramadasVencidas(db: Db, ahora: Date, limite = 200): Promise<ProgramadaVencida[]> {
  const { rows } = await db.query<ProgramadaVencida>(
    `SELECT p.cliente_id, p.id AS pieza_id, pr.id AS produccion_id, p.fecha_hora, u.numero_intento, u.resultado, u.resultado_en
     FROM piezas p
     JOIN planes_semanales pl ON pl.id = p.plan_id AND pl.cliente_id = p.cliente_id
     JOIN producciones pr ON pr.pieza_id = p.id AND pr.cliente_id = p.cliente_id AND pr.es_actual
     LEFT JOIN LATERAL (
       SELECT a.numero_intento, r.estado AS resultado, r.creado_en AS resultado_en
       FROM publicaciones a
       LEFT JOIN LATERAL (
         SELECT x.estado, x.creado_en FROM publicaciones_resultados x WHERE x.publicacion_id = a.id AND x.cliente_id = a.cliente_id ORDER BY x.seq DESC LIMIT 1
       ) r ON true
       WHERE a.produccion_id = pr.id AND a.cliente_id = pr.cliente_id ORDER BY a.numero_intento DESC LIMIT 1
     ) u ON true
     WHERE pl.estado = 'aprobado' AND p.estado = 'programada' AND p.fecha_hora <= $1
     ORDER BY p.fecha_hora, p.id LIMIT $2`,
    [ahora, limite],
  );
  return rows;
}

/** How many automatic "no approval" reschedules the piece has had since a person last scheduled it. */
export async function contarReprogramacionesAutomaticas(db: Db, clienteId: ClienteId, piezaId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auditoria a
     WHERE a.cliente_id = $1 AND a.fila_id = $2 AND a.accion = 'reprogramar_sin_aprobacion'
       AND a.creado_en > coalesce((SELECT max(b.creado_en) FROM auditoria b
                                   WHERE b.cliente_id = $1 AND b.fila_id = $2 AND b.accion IN ('programar_pieza', 'reprogramar_pieza')), '-infinity'::timestamptz)`,
    [clienteId, piezaId],
  );
  return Number(rows[0]!.n);
}

export interface MedicionPendiente {
  cliente_id: ClienteId;
  publicacion_id: string;
  pieza_id: string;
  pieza_estado: string;
  conexion_id: string;
  red: Red;
  id_externo: string;
  ventana: VentanaMetricas;
}

/** Windows (24h, 72h, 7d, 28d after publishing) that are due and have no snapshot yet. Oldest due first. */
export async function listMedicionesPendientes(
  db: Db,
  ahora: Date,
  opciones: { limite?: number; clienteId?: ClienteId; piezaId?: string } = {},
): Promise<MedicionPendiente[]> {
  const limite = opciones.limite ?? 100;
  const horas = ventanasDeMedicion(new Date(0)).map((v) => v.en.getTime() / 3_600_000);
  const { rows } = await db.query<MedicionPendiente>(
    `SELECT pu.cliente_id, pu.id AS publicacion_id, pu.pieza_id, pz.estado AS pieza_estado, pu.conexion_id, pu.red, r.id_externo, v.ventana
     FROM publicaciones_resultados r
     JOIN publicaciones pu ON pu.id = r.publicacion_id AND pu.cliente_id = r.cliente_id
     JOIN piezas pz ON pz.id = pu.pieza_id AND pz.cliente_id = pu.cliente_id
     CROSS JOIN unnest($2::text[], $3::int[]) AS v(ventana, horas)
     WHERE r.estado = 'publicada' AND pz.estado IN ('publicada', 'en_medicion')
       AND r.creado_en + make_interval(hours => v.horas) <= $1
       AND NOT EXISTS (SELECT 1 FROM metricas_pieza m WHERE m.publicacion_id = pu.id AND m.ventana = v.ventana)
       AND ($5::uuid IS NULL OR pu.cliente_id = $5) AND ($6::uuid IS NULL OR pu.pieza_id = $6)
     ORDER BY r.creado_en + make_interval(hours => v.horas), pu.id LIMIT $4`,
    [ahora, [...VENTANAS], horas, limite, opciones.clienteId ?? null, opciones.piezaId ?? null],
  );
  return rows;
}

/** Inserts a snapshot. A repeated job cannot duplicate it (unique per publication and window): returns false then. */
export async function insertMetricas(db: Db, clienteId: ClienteId, publicacionId: string, ventana: VentanaMetricas, m: MetricasNormalizadas, recogidaEn: Date): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO metricas_pieza
       (cliente_id, publicacion_id, ventana, recogida_en, impresiones, alcance, reproducciones, me_gusta, comentarios, compartidos, guardados,
        tiempo_reproduccion_promedio_seg, retencion_pct, visitas_perfil, clics_enlace, seguidores_ganados)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (publicacion_id, ventana) DO NOTHING`,
    [
      clienteId,
      publicacionId,
      ventana,
      recogidaEn,
      m.impresiones,
      m.alcance,
      m.reproducciones,
      m.me_gusta,
      m.comentarios,
      m.compartidos,
      m.guardados,
      m.tiempo_reproduccion_promedio_seg,
      m.retencion_pct,
      m.visitas_perfil,
      m.clics_enlace,
      m.seguidores_ganados,
    ],
  );
  return (rowCount ?? 0) > 0;
}

export interface SnapshotView {
  ventana: VentanaMetricas;
  recogida_en: Date;
  metricas: MetricasNormalizadas;
}

type FilaMetricas = { [K in keyof MetricasNormalizadas]: string | null };
const METRICAS_COLS = `m.impresiones, m.alcance, m.reproducciones, m.me_gusta, m.comentarios, m.compartidos, m.guardados,
  m.tiempo_reproduccion_promedio_seg, m.retencion_pct, m.visitas_perfil, m.clics_enlace, m.seguidores_ganados`;

const num = (v: string | null): number | null => (v === null ? null : Number(v));
export function aMetricas(f: FilaMetricas): MetricasNormalizadas {
  return {
    impresiones: num(f.impresiones),
    alcance: num(f.alcance),
    reproducciones: num(f.reproducciones),
    me_gusta: num(f.me_gusta),
    comentarios: num(f.comentarios),
    compartidos: num(f.compartidos),
    guardados: num(f.guardados),
    tiempo_reproduccion_promedio_seg: num(f.tiempo_reproduccion_promedio_seg),
    retencion_pct: num(f.retencion_pct),
    visitas_perfil: num(f.visitas_perfil),
    clics_enlace: num(f.clics_enlace),
    seguidores_ganados: num(f.seguidores_ganados),
  };
}

export interface PublicacionPublicada {
  publicacion_id: string;
  id_externo: string;
  enlace: string | null;
  publicada_en: Date;
}

/** The publication that went out for a piece (the single `publicada` result), or null. */
export async function getPublicacionPublicada(db: Db, clienteId: ClienteId, piezaId: string): Promise<PublicacionPublicada | null> {
  const { rows } = await db.query<PublicacionPublicada>(
    `SELECT r.publicacion_id, r.id_externo, r.enlace, r.creado_en AS publicada_en
     FROM publicaciones_resultados r WHERE r.cliente_id = $1 AND r.pieza_id = $2 AND r.estado = 'publicada'`,
    [clienteId, piezaId],
  );
  return rows[0] ?? null;
}

/** The snapshots of a published piece, in window order. */
export async function listSnapshotsDePieza(db: Db, clienteId: ClienteId, piezaId: string): Promise<SnapshotView[]> {
  const { rows } = await db.query<FilaMetricas & { ventana: VentanaMetricas; recogida_en: Date }>(
    `SELECT m.ventana, m.recogida_en, ${METRICAS_COLS}
     FROM metricas_pieza m JOIN publicaciones pu ON pu.id = m.publicacion_id AND pu.cliente_id = m.cliente_id
     WHERE m.cliente_id = $1 AND pu.pieza_id = $2
     ORDER BY array_position($3::text[], m.ventana)`,
    [clienteId, piezaId, [...VENTANAS]],
  );
  return rows.map((r) => ({ ventana: r.ventana, recogida_en: r.recogida_en, metricas: aMetricas(r) }));
}

export interface ResultadoSemanaFila {
  pieza_id: string;
  red: Red;
  formato: string;
  publicada_en: Date;
  enlace: string | null;
  ventana: VentanaMetricas | null;
  recogida_en: Date | null;
  metricas: MetricasNormalizadas | null;
}

/** The published pieces of the client's plan for a week (the Monday), each with its latest snapshot. */
export async function listResultadosSemana(db: Db, clienteId: ClienteId, semanaInicio: string): Promise<ResultadoSemanaFila[]> {
  const { rows } = await db.query<
    FilaMetricas & { pieza_id: string; red: Red; formato: string; publicada_en: Date; enlace: string | null; ventana: VentanaMetricas | null; recogida_en: Date | null; hay: boolean }
  >(
    `SELECT p.id AS pieza_id, p.red, p.formato, r.creado_en AS publicada_en, r.enlace, m.ventana, m.recogida_en, (m.publicacion_id IS NOT NULL) AS hay, ${METRICAS_COLS}
     FROM piezas p
     JOIN planes_semanales pl ON pl.id = p.plan_id AND pl.cliente_id = p.cliente_id
     JOIN publicaciones_resultados r ON r.pieza_id = p.id AND r.cliente_id = p.cliente_id AND r.estado = 'publicada'
     LEFT JOIN LATERAL (
       SELECT x.* FROM metricas_pieza x WHERE x.publicacion_id = r.publicacion_id AND x.cliente_id = r.cliente_id
       ORDER BY array_position($3::text[], x.ventana) DESC LIMIT 1
     ) m ON true
     WHERE p.cliente_id = $1 AND pl.semana_inicio = $2::date AND pl.estado <> 'descartado'
     ORDER BY r.creado_en, p.id`,
    [clienteId, semanaInicio, [...VENTANAS]],
  );
  return rows.map((r) => ({
    pieza_id: r.pieza_id,
    red: r.red,
    formato: r.formato,
    publicada_en: r.publicada_en,
    enlace: r.enlace,
    ventana: r.ventana,
    recogida_en: r.recogida_en,
    metricas: r.hay ? aMetricas(r) : null,
  }));
}
