import type { Db } from '../../db/types.js';
import { estadoAprobacion, type EstadoAprobacion } from '../aprobaciones/estadoAprobacion.js';
import type { ProduccionActual, RegistroAprobacion } from '../aprobaciones/types.js';
import type { EstadoPieza } from '../piezas/estados.js';
import { PIEZA_COLUMNS, PIEZA_FROM, type PiezaRow } from '../piezas/piezasRepository.js';
import { PLAN_COLUMNS, type PlanRow } from '../planificador/planesRepository.js';
import { usdToMicro } from '../presupuesto/money.js';
import type { ClienteId } from '../shared/clienteId.js';

// Reads of the dashboard (Step 11, checkpoint D). Every query filters by cliente_id, except the NovaCiel
// overview, which reads the clients of ONE page of ids (`cliente_id = ANY($ids)`) for staff only.
// No query runs per piece or per client: every list is read with a constant number of statements.
// Nothing here returns client text beyond what the existing piece views already return (idea, pilar).

/** A piece joined with its plan's zone, which the piece view needs for the local time. */
export type PiezaConZona = PiezaRow & { zona_horaria: string };

const PIEZA_SELECT = `${PIEZA_COLUMNS}, pl.zona_horaria AS zona_horaria`;

export const SEMANA_MAX_PIEZAS = 200;
export const PIEZAS_DEFAULT_LIMIT = 50;
export const PIEZAS_MAX_LIMIT = 100;
export const RESUMEN_DEFAULT_LIMIT = 50;
export const RESUMEN_MAX_LIMIT = 100;
/** Overview counts by state cover pieces scheduled in the last 35 days and everything in the future. */
export const RESUMEN_VENTANA_DIAS = 35;

export class CursorInvalidoError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'CursorInvalidoError';
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PIEZA_CURSOR_RE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z)\\|(${UUID})$`, 'i');
const CLIENTE_CURSOR_RE = new RegExp(`^(.*)\\|(${UUID})$`, 's');
const encode = (value: string) => Buffer.from(value).toString('base64url');
const decode = (cursor: string) => Buffer.from(cursor, 'base64url').toString('utf8');

// ---- Week overview ---------------------------------------------------------------------------------

/**
 * The non-discarded plan of the week of `semana` (a Monday), or, without it, the plan whose week contains today
 * on the wall clock of the plan's own zone. Uses planes_semanales_activo_key (cliente_id, semana_inicio).
 */
export async function getPlanDeLaSemana(db: Db, clienteId: ClienteId, semana?: string): Promise<PlanRow | null> {
  if (semana !== undefined) {
    const { rows } = await db.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM planes_semanales WHERE cliente_id = $1 AND semana_inicio = $2::date AND estado <> 'descartado'`,
      [clienteId, semana],
    );
    return rows[0] ?? null;
  }
  const { rows } = await db.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM planes_semanales
     WHERE cliente_id = $1 AND estado <> 'descartado'
       AND semana_inicio <= (now() AT TIME ZONE zona_horaria)::date
       AND semana_inicio + 7 > (now() AT TIME ZONE zona_horaria)::date
     ORDER BY semana_inicio DESC LIMIT 1`,
    [clienteId],
  );
  return rows[0] ?? null;
}

/** The pieces of a plan by scheduled time (then id), at most SEMANA_MAX_PIEZAS. Uses piezas_cliente_plan_idx. */
export async function listPiezasDelPlan(db: Db, clienteId: ClienteId, planId: string): Promise<PiezaConZona[]> {
  const { rows } = await db.query<PiezaConZona>(
    `SELECT ${PIEZA_SELECT} ${PIEZA_FROM} WHERE p.cliente_id = $1 AND p.plan_id = $2 ORDER BY p.fecha_hora, p.id LIMIT $3`,
    [clienteId, planId, SEMANA_MAX_PIEZAS],
  );
  return rows;
}

// ---- Approval and QC summary of many pieces, in three statements -----------------------------------

export interface ResumenPieza {
  /** Null when the piece has no current production yet. */
  aprobacion: EstadoAprobacion | null;
  /** The latest report of the CURRENT production, or null. */
  qc: { resultado: 'aprobado' | 'rechazado'; version: number; creado_en: Date; codigos_fallo: string[]; codigos_advertencia: string[] } | null;
}

/**
 * Approval state and QC summary for `piezaIds` of one client. Three statements whatever the number of pieces:
 * current productions (producciones_actual_key), decisions (aprobaciones_pieza_idx), latest QC report of the
 * current production (revisiones_calidad_pieza_idx). The approval state is the same pure function the
 * review route uses.
 */
export async function resumenesDePiezas(db: Db, clienteId: ClienteId, piezaIds: readonly string[]): Promise<Map<string, ResumenPieza>> {
  const out = new Map<string, ResumenPieza>();
  for (const id of piezaIds) out.set(id, { aprobacion: null, qc: null });
  if (piezaIds.length === 0) return out;
  const ids = [...piezaIds];

  // Sequential on purpose: `db` may be a single transaction client, which must not run two queries at once.
  const producciones = await db.query<{ pieza_id: string; id: string; version: number; hash_version: string; hash_pieza: Buffer }>(
    'SELECT pieza_id, id, version, hash_version, hash_pieza FROM producciones WHERE cliente_id = $1 AND pieza_id = ANY($2::uuid[]) AND es_actual',
    [clienteId, ids],
  );
  const registros = await db.query<{ seq: string; pieza_id: string; produccion_id: string; version: number; hash_version: string; hash_pieza: Buffer; nivel: 'interno' | 'cliente'; decision: 'aprobada' | 'cambios' | 'rechazada' }>(
    `SELECT seq::text AS seq, pieza_id, produccion_id, version, hash_version, hash_pieza, nivel, decision
     FROM aprobaciones WHERE cliente_id = $1 AND pieza_id = ANY($2::uuid[]) ORDER BY pieza_id, seq`,
    [clienteId, ids],
  );
  const revisiones = await db.query<{ pieza_id: string; resultado: 'aprobado' | 'rechazado'; produccion_version: number; creado_en: Date; codigos_fallo: string[]; codigos_advertencia: string[] }>(
    `SELECT DISTINCT ON (r.pieza_id) r.pieza_id, r.resultado, r.produccion_version, r.creado_en, r.codigos_fallo,
            ARRAY(SELECT c->>'codigo' FROM jsonb_array_elements(r.checks) c WHERE c->>'resultado' = 'advertencia') AS codigos_advertencia
     FROM revisiones_calidad r
     JOIN producciones x ON x.id = r.produccion_id AND x.cliente_id = r.cliente_id
     WHERE r.cliente_id = $1 AND r.pieza_id = ANY($2::uuid[]) AND x.es_actual
     ORDER BY r.pieza_id, r.seq DESC`,
    [clienteId, ids],
  );

  const registrosPorPieza = new Map<string, RegistroAprobacion[]>();
  for (const r of registros.rows) {
    const list = registrosPorPieza.get(r.pieza_id) ?? [];
    list.push({ seq: r.seq, produccionId: r.produccion_id, version: r.version, hashVersion: r.hash_version, hashPieza: r.hash_pieza, nivel: r.nivel, decision: r.decision });
    registrosPorPieza.set(r.pieza_id, list);
  }
  for (const p of producciones.rows) {
    const actual: ProduccionActual = { id: p.id, version: p.version, hashVersion: p.hash_version, hashPieza: p.hash_pieza };
    out.get(p.pieza_id)!.aprobacion = estadoAprobacion(actual, registrosPorPieza.get(p.pieza_id) ?? []);
  }
  for (const r of revisiones.rows) {
    out.get(r.pieza_id)!.qc = {
      resultado: r.resultado,
      version: r.produccion_version,
      creado_en: r.creado_en,
      codigos_fallo: r.codigos_fallo,
      codigos_advertencia: r.codigos_advertencia,
    };
  }
  return out;
}

// ---- Pieces by state --------------------------------------------------------------------------------

export interface PiezasFiltros {
  estados?: readonly EstadoPieza[];
  red?: string;
  formato?: string;
  desde?: Date;
  hasta?: Date;
  limit?: number;
  antes?: string;
}

/**
 * One page of the client's pieces (pieces of discarded plans hidden), ordered by (fecha_hora, id) with an
 * opaque keyset cursor that keeps the microseconds. With `estados` the index piezas_cliente_estado_fecha_idx
 * serves the filter; without it a client's pieces (hundreds) are sorted.
 */
export async function pagePiezas(db: Db, clienteId: ClienteId, f: PiezasFiltros = {}): Promise<{ items: PiezaConZona[]; next: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? PIEZAS_DEFAULT_LIMIT), 1), PIEZAS_MAX_LIMIT);
  const params: unknown[] = [clienteId];
  const where = ['p.cliente_id = $1', `pl.estado <> 'descartado'`];
  if (f.estados && f.estados.length > 0) {
    params.push([...f.estados]);
    where.push(`p.estado = ANY($${params.length}::text[]::estado_pieza[])`);
  }
  if (f.red) {
    params.push(f.red);
    where.push(`p.red = $${params.length}`);
  }
  if (f.formato) {
    params.push(f.formato);
    where.push(`p.formato = $${params.length}`);
  }
  if (f.desde) {
    params.push(f.desde);
    where.push(`p.fecha_hora >= $${params.length}`);
  }
  if (f.hasta) {
    params.push(f.hasta);
    where.push(`p.fecha_hora < $${params.length}`);
  }
  if (f.antes !== undefined) {
    const match = PIEZA_CURSOR_RE.exec(decode(f.antes));
    if (!match) throw new CursorInvalidoError();
    params.push(match[1], match[2]);
    where.push(`(p.fecha_hora, p.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const { rows } = await db.query<PiezaConZona & { cursor_ts: string }>(
    `SELECT ${PIEZA_SELECT}, to_char(p.fecha_hora AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
     ${PIEZA_FROM} WHERE ${where.join(' AND ')} ORDER BY p.fecha_hora, p.id LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, next: rows.length > limit && last ? encode(`${last.cursor_ts}|${last.id}`) : null };
}

/** Counts by state of the client's pieces (pieces of discarded plans excluded). One statement. */
export async function conteosPorEstado(db: Db, clienteId: ClienteId): Promise<Record<string, number>> {
  const { rows } = await db.query<{ estado: string; n: string }>(
    `SELECT p.estado, count(*)::text AS n ${PIEZA_FROM} WHERE p.cliente_id = $1 AND pl.estado <> 'descartado' GROUP BY p.estado`,
    [clienteId],
  );
  return Object.fromEntries(rows.map((r) => [r.estado, Number(r.n)]));
}

// ---- Spend history ----------------------------------------------------------------------------------

export interface MesDeGasto {
  periodo: string;
  /** numeric(18,6) as text. */
  gastado: string;
  /** The month's ceiling, or the client's default one; null when neither exists. */
  techo: string | null;
}

/**
 * The last `meses` months (the current one first) of settled spend and ceiling of one client. One statement:
 * libro_gastos_cliente_periodo_idx for the sums, topes (cliente_id, periodo) for the ceilings.
 */
export async function historialGasto(db: Db, clienteId: ClienteId, meses: number): Promise<MesDeGasto[]> {
  const { rows } = await db.query<MesDeGasto>(
    `WITH p AS (
       SELECT (date_trunc('month', now() AT TIME ZONE 'UTC')::date - make_interval(months => n))::date AS periodo
       FROM generate_series(0, $2::int - 1) n
     )
     SELECT p.periodo::text AS periodo,
            (SELECT coalesce(sum(l.costo_real), 0) FROM libro_gastos l WHERE l.cliente_id = $1 AND l.periodo = p.periodo)::text AS gastado,
            coalesce(t.monto_techo, cg.techo_mensual_defecto)::text AS techo
     FROM p
     LEFT JOIN topes t ON t.cliente_id = $1 AND t.periodo = p.periodo
     LEFT JOIN configuracion_gasto_cliente cg ON cg.cliente_id = $1
     ORDER BY p.periodo DESC`,
    [clienteId, meses],
  );
  return rows;
}

// ---- NovaCiel overview ------------------------------------------------------------------------------

export interface ClienteBase {
  id: string;
  nombre_comercial: string;
  estado: string;
}

/** One page of clients ordered by (nombre_comercial, id) with an opaque keyset cursor. */
export async function pageClientes(db: Db, options: { limit?: number; antes?: string } = {}): Promise<{ items: ClienteBase[]; next: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? RESUMEN_DEFAULT_LIMIT), 1), RESUMEN_MAX_LIMIT);
  const params: unknown[] = [];
  let where = '';
  if (options.antes !== undefined) {
    const match = CLIENTE_CURSOR_RE.exec(decode(options.antes));
    if (!match) throw new CursorInvalidoError();
    params.push(match[1], match[2]);
    where = 'WHERE (nombre_comercial, id) > ($1::text, $2::uuid)';
  }
  params.push(limit + 1);
  const { rows } = await db.query<ClienteBase>(
    `SELECT id, nombre_comercial, estado FROM clientes ${where} ORDER BY nombre_comercial, id LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, next: rows.length > limit && last ? encode(`${last.nombre_comercial}|${last.id}`) : null };
}

export interface ResumenCliente {
  conteos: Record<string, number>;
  pendientes: { novaciel: number; cliente: number; planes_propuestos: number };
  alertas_abiertas: { total: number; criticas: number };
  presupuesto: { periodo: string; techo: bigint | null; usado: bigint; porcentaje: number | null; interruptor_cliente: boolean };
}

/** Same formula as getSpendSummary: basis points with bigint division (floor), two decimals; a zero ceiling is 100. */
function porcentajeDe(ceiling: bigint | null, used: bigint): number | null {
  if (ceiling === null) return null;
  return ceiling === 0n ? 100 : Number((used * 10_000n) / ceiling) / 100;
}

/**
 * The overview rows of the clients of one page, in five statements whatever their number:
 * state counts (window), pending approvals, open alerts, and budget of the current month. Ids only come from
 * a page of `pageClientes`; every statement filters `cliente_id = ANY($ids)`.
 */
export async function resumenesDeClientes(db: Db, clienteIds: readonly string[], periodo: string): Promise<Map<string, ResumenCliente>> {
  const out = new Map<string, ResumenCliente>();
  for (const id of clienteIds) {
    out.set(id, {
      conteos: {},
      pendientes: { novaciel: 0, cliente: 0, planes_propuestos: 0 },
      alertas_abiertas: { total: 0, criticas: 0 },
      presupuesto: { periodo, techo: null, usado: 0n, porcentaje: null, interruptor_cliente: true },
    });
  }
  if (clienteIds.length === 0) return out;
  const ids = [...clienteIds];

  // Sequential on purpose: `db` may be a single transaction client, which must not run two queries at once.
  const conteos = await db.query<{ cliente_id: string; estado: string; n: string }>(
    `SELECT p.cliente_id, p.estado, count(*)::text AS n
     FROM piezas p JOIN planes_semanales pl ON pl.id = p.plan_id AND pl.cliente_id = p.cliente_id
     WHERE p.cliente_id = ANY($1::uuid[]) AND pl.estado <> 'descartado' AND p.fecha_hora >= now() - make_interval(days => $2::int)
     GROUP BY p.cliente_id, p.estado`,
    [ids, RESUMEN_VENTANA_DIAS],
  );
  // The same predicate as listPiezasPendientes (approved plan, current production), no window.
  const pendientes = await db.query<{ cliente_id: string; estado: string; n: string }>(
    `SELECT p.cliente_id, p.estado, count(*)::text AS n
     FROM piezas p
     JOIN planes_semanales pl ON pl.id = p.plan_id AND pl.cliente_id = p.cliente_id
     JOIN producciones pr ON pr.pieza_id = p.id AND pr.cliente_id = p.cliente_id AND pr.es_actual
     WHERE p.cliente_id = ANY($1::uuid[]) AND pl.estado = 'aprobado' AND p.estado IN ('revision_novaciel', 'esperando_aprobacion')
     GROUP BY p.cliente_id, p.estado`,
    [ids],
  );
  const planes = await db.query<{ cliente_id: string; n: string }>(
    `SELECT cliente_id, count(*)::text AS n FROM planes_semanales WHERE cliente_id = ANY($1::uuid[]) AND estado = 'propuesto' GROUP BY cliente_id`,
    [ids],
  );
  const alertas = await db.query<{ cliente_id: string; total: string; criticas: string }>(
    `SELECT a.cliente_id, count(*)::text AS total, (count(*) FILTER (WHERE a.severidad = 'critica'))::text AS criticas
     FROM alertas a LEFT JOIN alertas_reconocimientos r ON r.alerta_id = a.id
     WHERE a.cliente_id = ANY($1::uuid[]) AND r.alerta_id IS NULL GROUP BY a.cliente_id`,
    [ids],
  );
  const presupuesto = await db.query<{ cliente_id: string; techo: string | null; interruptor: boolean | null; spent: string; reserved: string }>(
    `SELECT c.id AS cliente_id,
            coalesce(t.monto_techo, cg.techo_mensual_defecto)::text AS techo,
            cg.gasto_habilitado AS interruptor,
            (SELECT coalesce(sum(l.costo_real), 0) FROM libro_gastos l WHERE l.cliente_id = c.id AND l.periodo = $2::date)::text AS spent,
            (SELECT coalesce(sum(a.monto_estimado), 0) FROM autorizaciones_gasto a
               WHERE a.cliente_id = c.id AND a.periodo = $2::date AND a.estado = 'reservada' AND a.expira_en > now())::text AS reserved
     FROM clientes c
     LEFT JOIN topes t ON t.cliente_id = c.id AND t.periodo = $2::date
     LEFT JOIN configuracion_gasto_cliente cg ON cg.cliente_id = c.id
     WHERE c.id = ANY($1::uuid[])`,
    [ids, periodo],
  );

  for (const r of conteos.rows) out.get(r.cliente_id)!.conteos[r.estado] = Number(r.n);
  for (const r of pendientes.rows) {
    const p = out.get(r.cliente_id)!.pendientes;
    if (r.estado === 'revision_novaciel') p.novaciel = Number(r.n);
    else p.cliente = Number(r.n);
  }
  for (const r of planes.rows) out.get(r.cliente_id)!.pendientes.planes_propuestos = Number(r.n);
  for (const r of alertas.rows) out.get(r.cliente_id)!.alertas_abiertas = { total: Number(r.total), criticas: Number(r.criticas) };
  for (const r of presupuesto.rows) {
    const techo = r.techo === null ? null : usdToMicro(r.techo);
    const usado = usdToMicro(r.spent) + usdToMicro(r.reserved);
    out.get(r.cliente_id)!.presupuesto = { periodo, techo, usado, porcentaje: porcentajeDe(techo, usado), interruptor_cliente: r.interruptor ?? true };
  }
  return out;
}

/** Open alerts without a client, the global switch and the current period: the overview's header. One statement. */
export async function cabeceraResumen(db: Db): Promise<{ periodo: string; interruptor_global: boolean; alertas_globales_abiertas: number; alertas_globales_criticas: number }> {
  const { rows } = await db.query<{ periodo: string; global: boolean | null; total: string; criticas: string }>(
    `SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS periodo,
            (SELECT gasto_habilitado FROM interruptor_global) AS global,
            (SELECT count(*) FROM alertas a LEFT JOIN alertas_reconocimientos r ON r.alerta_id = a.id WHERE a.cliente_id IS NULL AND r.alerta_id IS NULL)::text AS total,
            (SELECT count(*) FROM alertas a LEFT JOIN alertas_reconocimientos r ON r.alerta_id = a.id
               WHERE a.cliente_id IS NULL AND r.alerta_id IS NULL AND a.severidad = 'critica')::text AS criticas`,
  );
  const r = rows[0]!;
  // A missing global row must not mean "spending allowed" (same rule as getSwitches).
  return { periodo: r.periodo, interruptor_global: r.global ?? false, alertas_globales_abiertas: Number(r.total), alertas_globales_criticas: Number(r.criticas) };
}
