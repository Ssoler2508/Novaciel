import type { Db } from '../../../src/db/types.js';
import { createCliente } from './clientes.js';
import { createPerfilMarca } from './perfilMarca.js';
import { createPieza, createPlanSemanal } from './planesPiezas.js';
import { uniqueSuffix } from './unique.js';

// Plain SQL, no audit: they go through the database triggers like the real service will.

export interface GuionRow {
  id: string;
  cliente_id: string;
  pieza_id: string;
  version: number;
  es_actual: boolean;
  perfil_marca_id: string;
  formato: string;
  contenido_modelo: Record<string, unknown>;
  contenido: Record<string, unknown>;
  creado_por: string | null;
  creado_en: Date;
}

export interface TomaRow {
  guion_id: string;
  cliente_id: string;
  orden: number;
  fuente: 'media_real' | 'faltante';
  media_id: string | null;
  motivo_faltante: string | null;
  entrada_ms: number | null;
  salida_ms: number | null;
  creado_en: Date;
}

export interface GuionHechoRow {
  guion_id: string;
  hecho_id: string;
  cliente_id: string;
  creado_en: Date;
}

export interface TomaInput {
  /** Defaults to 'media_real' when mediaId is given, else 'faltante'. */
  fuente?: 'media_real' | 'faltante';
  mediaId?: string | null;
  motivoFaltante?: string | null;
  entradaMs?: number | null;
  salidaMs?: number | null;
}

export interface GuionOverrides {
  clienteId?: string;
  /**
   * An existing piece. When omitted, the factory builds an APPROVED plan with a piece in
   * plan_aprobado, the only place a brief can be born.
   */
  piezaId?: string;
  /** Defaults to the next version of the piece. */
  version?: number;
  /**
   * Defaults to true. A previous current brief of the piece is retired first, like the service does.
   * false inserts it current (a brief is born current) and retires it right after.
   */
  esActual?: boolean;
  perfilMarcaId?: string;
  formato?: string;
  contenidoModelo?: Record<string, unknown>;
  contenido?: Record<string, unknown>;
  creadoPor?: string | null;
  /** Slots, in order (orden 1, 2, ...). */
  tomas?: TomaInput[];
  /** Verified facts the brief uses. */
  hechoIds?: string[];
}

export function guionContenido(text = `Texto ficticio ${uniqueSuffix()}`): Record<string, unknown> {
  return {
    gancho: text,
    escenas: [{ orden: 1, texto_en_pantalla: text }],
    texto_publicacion: { texto: text, hashtags: [] },
    llamado_a_accion: 'Escríbenos',
    notas_produccion: 'Sin notas',
  };
}

export async function createToma(db: Db, params: { guionId: string; clienteId: string; orden: number } & TomaInput): Promise<TomaRow> {
  const mediaId = params.mediaId ?? null;
  const fuente = params.fuente ?? (mediaId ? 'media_real' : 'faltante');
  const { rows } = await db.query<TomaRow>(
    `INSERT INTO tomas (guion_id, cliente_id, orden, fuente, media_id, motivo_faltante, entrada_ms, salida_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      params.guionId,
      params.clienteId,
      params.orden,
      fuente,
      mediaId,
      params.motivoFaltante !== undefined ? params.motivoFaltante : fuente === 'faltante' ? 'No hay media adecuada' : null,
      params.entradaMs ?? null,
      params.salidaMs ?? null,
    ],
  );
  return rows[0]!;
}

export async function createGuionHecho(db: Db, params: { guionId: string; hechoId: string; clienteId: string }): Promise<GuionHechoRow> {
  const { rows } = await db.query<GuionHechoRow>(
    'INSERT INTO guiones_hechos (guion_id, hecho_id, cliente_id) VALUES ($1, $2, $3) RETURNING *',
    [params.guionId, params.hechoId, params.clienteId],
  );
  return rows[0]!;
}

/** Inserts a brief (and its slots and fact links). */
export async function createGuion(db: Db, overrides: GuionOverrides = {}): Promise<GuionRow> {
  let piezaId = overrides.piezaId;
  let clienteId = overrides.clienteId;
  let formato = overrides.formato;
  if (piezaId) {
    const pieza = (await db.query<{ cliente_id: string; formato: string }>('SELECT cliente_id, formato FROM piezas WHERE id = $1', [piezaId])).rows[0]!;
    clienteId ??= pieza.cliente_id;
    formato ??= pieza.formato;
  } else {
    clienteId ??= (await createCliente(db)).id;
    const plan = await createPlanSemanal(db, { clienteId, estado: 'aprobado' });
    const pieza = await createPieza(db, { clienteId, planId: plan.id, estado: 'plan_aprobado', ...(formato ? { formato } : {}) });
    piezaId = pieza.id;
    formato = pieza.formato;
  }
  let perfilMarcaId = overrides.perfilMarcaId;
  if (!perfilMarcaId) {
    const current = await db.query<{ id: string }>('SELECT id FROM perfil_marca WHERE cliente_id = $1 AND es_actual', [clienteId]);
    perfilMarcaId = current.rows[0]?.id ?? (await createPerfilMarca(db, { clienteId })).id;
  }
  const last = (await db.query<{ n: number }>('SELECT COALESCE(max(version), 0)::int AS n FROM guiones WHERE pieza_id = $1', [piezaId])).rows[0]!.n;
  await db.query('UPDATE guiones SET es_actual = false WHERE pieza_id = $1 AND es_actual', [piezaId]);
  const contenido = overrides.contenido ?? guionContenido();
  const { rows } = await db.query<GuionRow>(
    `INSERT INTO guiones (cliente_id, pieza_id, version, es_actual, perfil_marca_id, formato, contenido_modelo, contenido, creado_por)
     VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8) RETURNING *`,
    [
      clienteId,
      piezaId,
      overrides.version ?? last + 1,
      perfilMarcaId,
      formato,
      JSON.stringify(overrides.contenidoModelo ?? contenido),
      JSON.stringify(contenido),
      overrides.creadoPor ?? null,
    ],
  );
  const guion = rows[0]!;
  for (const [i, toma] of (overrides.tomas ?? []).entries()) {
    await createToma(db, { guionId: guion.id, clienteId: guion.cliente_id, orden: i + 1, ...toma });
  }
  for (const hechoId of overrides.hechoIds ?? []) {
    await createGuionHecho(db, { guionId: guion.id, hechoId, clienteId: guion.cliente_id });
  }
  if (overrides.esActual === false) {
    return (await db.query<GuionRow>('UPDATE guiones SET es_actual = false WHERE id = $1 RETURNING *', [guion.id])).rows[0]!;
  }
  return guion;
}
