import type { Db } from '../../../src/db/types.js';

// Plain SQL, no audit: it goes through the database trigger, which is what the table is about. The
// report is about the piece's CURRENT production unless an override says otherwise, so a test can
// build a stale or forged report on purpose.

export interface CheckQC {
  codigo: string;
  resultado: 'pasa' | 'no_pasa' | 'advertencia';
  severidad: 'bloqueante' | 'advertencia';
  motivo: string;
  parametros: Record<string, unknown>;
}

export interface RevisionCalidadRow {
  id: string;
  seq: string;
  cliente_id: string;
  pieza_id: string;
  produccion_id: string;
  produccion_version: number;
  hash_version: string;
  hash_pieza: Buffer;
  resultado: 'aprobado' | 'rechazado';
  checks: CheckQC[];
  codigos_fallo: string[];
  duracion_ms: number;
  actor_tipo: 'usuario' | 'sistema';
  actor_usuario_id: string | null;
  creado_en: Date;
}

export interface RevisionCalidadOverrides {
  piezaId: string;
  /** Defaults to 'aprobado' (or 'rechazado' when `checks` holds a failed one). */
  resultado?: RevisionCalidadRow['resultado'];
  /** Defaults to one passing check; when given, `codigosFallo` is derived from it unless overridden. */
  checks?: CheckQC[];
  codigosFallo?: string[];
  /** Defaults to the piece's current production. */
  produccionId?: string;
  produccionVersion?: number;
  hashVersion?: string;
  hashPieza?: Buffer;
  duracionMs?: number;
  actorUsuarioId?: string | null;
}

/** A check in the shape the table expects. A failed one is blocking by default. */
export function checkQC(codigo: string, resultado: CheckQC['resultado'] = 'pasa', parametros: Record<string, unknown> = {}): CheckQC {
  return {
    codigo,
    resultado,
    severidad: resultado === 'advertencia' ? 'advertencia' : 'bloqueante',
    motivo: resultado === 'pasa' ? 'Cumple.' : 'No cumple.',
    parametros,
  };
}

export async function createRevisionCalidad(db: Db, o: RevisionCalidadOverrides): Promise<RevisionCalidadRow> {
  const pieza = (await db.query<{ cliente_id: string }>('SELECT cliente_id FROM piezas WHERE id = $1', [o.piezaId])).rows[0]!;
  const current = (
    await db.query<{ id: string; version: number; hash_version: string; hash_pieza: Buffer }>(
      'SELECT id, version, hash_version, hash_pieza FROM producciones WHERE pieza_id = $1 AND es_actual',
      [o.piezaId],
    )
  ).rows[0];
  const checks = o.checks ?? [checkQC('archivo_hash_distinto')];
  const fallos = checks.filter((c) => c.resultado === 'no_pasa').map((c) => c.codigo);
  const { rows } = await db.query<RevisionCalidadRow>(
    `INSERT INTO revisiones_calidad
       (cliente_id, pieza_id, produccion_id, produccion_version, hash_version, hash_pieza, resultado, checks, codigos_fallo,
        duracion_ms, actor_tipo, actor_usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
     RETURNING *`,
    [
      pieza.cliente_id,
      o.piezaId,
      o.produccionId ?? current?.id,
      o.produccionVersion ?? current?.version,
      o.hashVersion ?? current?.hash_version,
      o.hashPieza ?? current?.hash_pieza,
      o.resultado ?? (fallos.length > 0 ? 'rechazado' : 'aprobado'),
      JSON.stringify(checks),
      o.codigosFallo ?? fallos,
      o.duracionMs ?? 12,
      o.actorUsuarioId ? 'usuario' : 'sistema',
      o.actorUsuarioId ?? null,
    ],
  );
  return rows[0]!;
}
