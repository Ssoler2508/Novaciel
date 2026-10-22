import type { Db } from '../../../src/db/types.js';
import { runInTransaction } from '../../../src/db/transaction.js';
import { createCliente } from './clientes.js';
import { createPerfilMarca } from './perfilMarca.js';
import { uniqueSuffix } from './unique.js';

// Plain SQL, no audit. They go through the database triggers like the real services will: a piece
// is created with its creation history row, and a state change writes the history row first.

export interface PlanSemanalRow {
  id: string;
  cliente_id: string;
  semana_inicio: string;
  zona_horaria: string;
  estado: 'borrador' | 'propuesto' | 'aprobado' | 'descartado';
  perfil_marca_id: string;
  creado_por: string | null;
  creado_en: Date;
}

export interface PlanSemanalOverrides {
  clienteId?: string;
  /** A Monday, as YYYY-MM-DD. */
  semanaInicio?: string;
  zonaHoraria?: string;
  estado?: PlanSemanalRow['estado'];
  /** Defaults to the client's current profile version (one is created when there is none). */
  perfilMarcaId?: string;
  creadoPor?: string | null;
}

export const DEFAULT_MONDAY = '2026-11-02';

export async function createPlanSemanal(db: Db, overrides: PlanSemanalOverrides = {}): Promise<PlanSemanalRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  let perfilMarcaId = overrides.perfilMarcaId;
  if (!perfilMarcaId) {
    const current = await db.query<{ id: string }>('SELECT id FROM perfil_marca WHERE cliente_id = $1 AND es_actual', [clienteId]);
    perfilMarcaId = current.rows[0]?.id ?? (await createPerfilMarca(db, { clienteId })).id;
  }
  const { rows } = await db.query<PlanSemanalRow>(
    `INSERT INTO planes_semanales (cliente_id, semana_inicio, zona_horaria, estado, perfil_marca_id, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, cliente_id, semana_inicio::text AS semana_inicio, zona_horaria, estado, perfil_marca_id, creado_por, creado_en`,
    [
      clienteId,
      overrides.semanaInicio ?? DEFAULT_MONDAY,
      overrides.zonaHoraria ?? 'America/New_York',
      overrides.estado ?? 'borrador',
      perfilMarcaId,
      overrides.creadoPor ?? null,
    ],
  );
  return rows[0]!;
}

export interface PiezaRow {
  id: string;
  cliente_id: string;
  plan_id: string;
  red: string;
  formato: string;
  pilar: string;
  trabajo: string;
  idea: string;
  fecha_hora: Date;
  estado: string;
  estado_previo: string | null;
  version_estado: number;
  creado_en: Date;
  actualizado_en: Date;
}

export interface PiezaOverrides {
  clienteId?: string;
  /** Defaults to a new plan of the client. */
  planId?: string;
  red?: string;
  formato?: string;
  pilar?: string;
  trabajo?: string;
  idea?: string;
  fechaHora?: Date;
  /** Walks the piece to this state through the allowed transitions (history rows included). */
  estado?: string;
}

export type HistorialActor = { tipo: 'sistema' } | { tipo: 'usuario'; usuarioId: string };

/** Inserts a piece in `planeada` and its creation history row (version 0). */
export async function createPieza(db: Db, overrides: PiezaOverrides = {}): Promise<PiezaRow> {
  let planId = overrides.planId;
  let clienteId = overrides.clienteId;
  if (planId) {
    clienteId ??= (await db.query<{ cliente_id: string }>('SELECT cliente_id FROM planes_semanales WHERE id = $1', [planId])).rows[0]!.cliente_id;
  } else {
    const plan = await createPlanSemanal(db, { clienteId });
    planId = plan.id;
    clienteId = plan.cliente_id;
  }
  const { rows } = await db.query<PiezaRow>(
    `INSERT INTO piezas (cliente_id, plan_id, red, formato, pilar, trabajo, idea, fecha_hora)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      clienteId,
      planId,
      overrides.red ?? 'instagram',
      overrides.formato ?? 'carrusel',
      overrides.pilar ?? 'pilar-de-prueba',
      overrides.trabajo ?? 'atraer',
      overrides.idea ?? `Idea ficticia ${uniqueSuffix()}`,
      overrides.fechaHora ?? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    ],
  );
  const pieza = rows[0]!;
  await insertHistorial(db, pieza.id, clienteId, { version: 0, desde: null, hacia: 'planeada', actor: { tipo: 'sistema' } });
  return overrides.estado && overrides.estado !== 'planeada' ? walkTo(db, pieza.id, overrides.estado) : pieza;
}

export async function insertHistorial(
  db: Db,
  piezaId: string,
  clienteId: string,
  row: { version: number; desde: string | null; hacia: string; actor: HistorialActor; motivo?: string | null },
): Promise<void> {
  // Many tests walk pieces through `aprobada`/`programada` without approvals. The database guard of Step 9
  // (historial_estados_pieza_aprobacion) has a test-only switch, transaction-scoped, that this helper turns
  // on for its own insert and puts back the previous value right after, so it never stays on for the rest of a test.
  await runInTransaction(db, async (tx) => {
    const previo = (await tx.query<{ v: string }>(`SELECT coalesce(current_setting('novaciel.omitir_guarda_aprobacion', true), 'no') AS v`)).rows[0]!.v;
    await tx.query(`SELECT set_config('novaciel.omitir_guarda_aprobacion', 'si', true)`);
    await tx.query(
      `INSERT INTO historial_estados_pieza (cliente_id, pieza_id, version, desde, hacia, actor_tipo, actor_usuario_id, motivo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [clienteId, piezaId, row.version, row.desde, row.hacia, row.actor.tipo, row.actor.tipo === 'usuario' ? row.actor.usuarioId : null, row.motivo ?? null],
    );
    await tx.query(`SELECT set_config('novaciel.omitir_guarda_aprobacion', $1, true)`, [previo]);
  });
}

/** Moves a piece one step: writes the history row, then updates the state (both go through the triggers). */
export async function moverPieza(
  db: Db,
  piezaId: string,
  hacia: string,
  options: { actor?: HistorialActor; motivo?: string } = {},
): Promise<PiezaRow> {
  // One transaction (also on a pool): the trigger needs the history row and the update to share it.
  return runInTransaction(db, async (tx) => {
    const current = (await tx.query<PiezaRow>('SELECT * FROM piezas WHERE id = $1 FOR UPDATE', [piezaId])).rows[0]!;
    await insertHistorial(tx, piezaId, current.cliente_id, {
      version: current.version_estado + 1,
      desde: current.estado,
      hacia,
      actor: options.actor ?? { tipo: 'sistema' },
      motivo: options.motivo ?? null,
    });
    return (await tx.query<PiezaRow>('UPDATE piezas SET estado = $2 WHERE id = $1 RETURNING *', [piezaId, hacia])).rows[0]!;
  });
}

/** Shortest path from the piece's state to `estado` over the allowed transitions, then walks it. */
async function walkTo(db: Db, piezaId: string, estado: string): Promise<PiezaRow> {
  const edges = (await db.query<{ desde: string; hacia: string }>('SELECT desde, hacia FROM transiciones_pieza ORDER BY desde, hacia')).rows;
  const start = (await db.query<{ estado: string }>('SELECT estado FROM piezas WHERE id = $1', [piezaId])).rows[0]!.estado;
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0 && !previous.has(estado)) {
    const from = queue.shift()!;
    for (const edge of edges) {
      // `pausada -> X` edges are skipped: a path never needs to resume, and resuming is only valid to estado_previo.
      if (edge.desde !== from || edge.desde === 'pausada' || previous.has(edge.hacia)) continue;
      previous.set(edge.hacia, from);
      queue.push(edge.hacia);
    }
  }
  if (!previous.has(estado)) throw new Error(`No path to state ${estado}`);
  const path: string[] = [];
  for (let at: string | null = estado; at !== null && at !== start; at = previous.get(at) ?? null) path.unshift(at);
  let pieza!: PiezaRow;
  for (const step of path) pieza = await moverPieza(db, piezaId, step);
  return pieza;
}

export interface PiezaHechoRow {
  pieza_id: string;
  hecho_id: string;
  cliente_id: string;
  creado_en: Date;
}

export async function createPiezaHecho(
  db: Db,
  params: { piezaId: string; hechoId: string; clienteId: string },
): Promise<PiezaHechoRow> {
  const { rows } = await db.query<PiezaHechoRow>(
    'INSERT INTO piezas_hechos (pieza_id, hecho_id, cliente_id) VALUES ($1, $2, $3) RETURNING *',
    [params.piezaId, params.hechoId, params.clienteId],
  );
  return rows[0]!;
}
