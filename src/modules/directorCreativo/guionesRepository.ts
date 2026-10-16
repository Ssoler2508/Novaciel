import type { Db } from '../../db/types.js';
import type { ClienteId } from '../shared/clienteId.js';
import type { BriefContent } from './schema.js';

// Reads of briefs (guiones) with their slots (tomas) and used facts (guiones_hechos). Every query
// filters by cliente_id. The rendered content is what the API shows: contenido_modelo (with fact
// tokens) is returned only when explicitly asked for.

export interface TomaView {
  orden: number;
  fuente: 'media_real' | 'faltante';
  media_id: string | null;
  motivo_faltante: string | null;
  entrada_ms: number | null;
  salida_ms: number | null;
}

export interface GuionView {
  id: string;
  cliente_id: ClienteId;
  pieza_id: string;
  version: number;
  es_actual: boolean;
  perfil_marca_id: string;
  formato: 'reel' | 'carrusel' | 'post' | 'historia';
  /** The rendered content: fact tokens already replaced by the stored values. */
  contenido: BriefContent;
  /** The model's output with tokens. Only present when asked for (`includeModel`). */
  contenido_modelo?: BriefContent;
  tomas: TomaView[];
  hecho_ids: string[];
  creado_por: string | null;
  creado_en: Date;
}

export interface GuionReadOptions {
  /** Briefs of a discarded plan are hidden by default, like its pieces. */
  includeDescartados?: boolean;
  includeModel?: boolean;
}

interface GuionRow {
  id: string;
  cliente_id: ClienteId;
  pieza_id: string;
  version: number;
  es_actual: boolean;
  perfil_marca_id: string;
  formato: GuionView['formato'];
  contenido: BriefContent;
  contenido_modelo: BriefContent;
  creado_por: string | null;
  creado_en: Date;
}

async function loadViews(db: Db, clienteId: ClienteId, piezaId: string, onlyCurrent: boolean, options: GuionReadOptions): Promise<GuionView[]> {
  const { rows } = await db.query<GuionRow>(
    `SELECT g.id, g.cliente_id, g.pieza_id, g.version, g.es_actual, g.perfil_marca_id, g.formato,
            g.contenido, g.contenido_modelo, g.creado_por, g.creado_en
     FROM guiones g
     JOIN piezas p ON p.id = g.pieza_id AND p.cliente_id = g.cliente_id
     JOIN planes_semanales pl ON pl.id = p.plan_id AND pl.cliente_id = p.cliente_id
     WHERE g.cliente_id = $1 AND g.pieza_id = $2 AND ($3::boolean OR g.es_actual) AND ($4::boolean OR pl.estado <> 'descartado')
     ORDER BY g.version`,
    [clienteId, piezaId, !onlyCurrent, options.includeDescartados ?? false],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const tomas = (
    await db.query<TomaView & { guion_id: string }>(
      `SELECT guion_id, orden, fuente, media_id, motivo_faltante, entrada_ms, salida_ms
       FROM tomas WHERE cliente_id = $1 AND guion_id = ANY($2::uuid[]) ORDER BY guion_id, orden`,
      [clienteId, ids],
    )
  ).rows;
  const hechos = (
    await db.query<{ guion_id: string; hecho_id: string }>(
      `SELECT guion_id, hecho_id FROM guiones_hechos WHERE cliente_id = $1 AND guion_id = ANY($2::uuid[]) ORDER BY guion_id, hecho_id`,
      [clienteId, ids],
    )
  ).rows;
  return rows.map((row) => ({
    id: row.id,
    cliente_id: row.cliente_id,
    pieza_id: row.pieza_id,
    version: row.version,
    es_actual: row.es_actual,
    perfil_marca_id: row.perfil_marca_id,
    formato: row.formato,
    contenido: row.contenido,
    ...(options.includeModel ? { contenido_modelo: row.contenido_modelo } : {}),
    tomas: tomas.filter((t) => t.guion_id === row.id).map(({ guion_id: _guion, ...toma }) => toma),
    hecho_ids: hechos.filter((h) => h.guion_id === row.id).map((h) => h.hecho_id),
    creado_por: row.creado_por,
    creado_en: row.creado_en,
  }));
}

/** The current brief of a piece of this client, or null (also for another client's piece). */
export async function getBriefActual(db: Db, clienteId: ClienteId, piezaId: string, options: GuionReadOptions = {}): Promise<GuionView | null> {
  return (await loadViews(db, clienteId, piezaId, true, options))[0] ?? null;
}

/** Every version of a piece's brief, oldest first. Empty for another client's piece. */
export function listBriefVersions(db: Db, clienteId: ClienteId, piezaId: string, options: GuionReadOptions = {}): Promise<GuionView[]> {
  return loadViews(db, clienteId, piezaId, false, options);
}
