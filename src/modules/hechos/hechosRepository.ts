import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';
import { deleteClientRow, updateClientRow } from '../shared/clientRows.js';

export type HechoTipo = 'precio' | 'horario' | 'promocion' | 'cifra' | 'otro';

export interface HechoRow {
  id: string;
  cliente_id: ClienteId;
  tipo: HechoTipo;
  enunciado: string;
  fuente: string;
  verificado_por: string;
  vigente_desde: Date;
  vigente_hasta: Date | null;
  creado_en: Date;
}

export interface NewHecho {
  tipo: HechoTipo;
  enunciado: string;
  fuente: string;
  verificadoPor: string;
  vigenteDesde?: Date;
  vigenteHasta?: Date | null;
}

export type HechoPatch = Partial<{
  tipo: HechoTipo;
  enunciado: string;
  fuente: string;
  verificado_por: string;
  vigente_desde: Date;
  vigente_hasta: Date | null;
}>;

const UPDATABLE = ['tipo', 'enunciado', 'fuente', 'verificado_por', 'vigente_desde', 'vigente_hasta'] as const;

export async function createHecho(db: Db, clienteId: ClienteId, params: NewHecho, actor: AuditActor): Promise<HechoRow> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<HechoRow>(
      `INSERT INTO hechos_verificados (cliente_id, tipo, enunciado, fuente, verificado_por, vigente_desde, vigente_hasta)
       VALUES ($1, $2, $3, $4, $5, coalesce($6, now()), $7) RETURNING *`,
      [
        clienteId,
        params.tipo,
        params.enunciado,
        params.fuente,
        params.verificadoPor,
        params.vigenteDesde ?? null,
        params.vigenteHasta ?? null,
      ],
    );
    const row = rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'crear',
      tabla: 'hechos_verificados',
      filaId: row.id,
      clienteId,
      despues: { ...row },
    });
    return row;
  });
}

export async function getHecho(db: Db, clienteId: ClienteId, id: string): Promise<HechoRow | null> {
  const { rows } = await db.query<HechoRow>('SELECT * FROM hechos_verificados WHERE id = $1 AND cliente_id = $2', [
    id,
    clienteId,
  ]);
  return rows[0] ?? null;
}

/** The facts with these ids that belong to the client (a missing id is simply absent), expired or not. */
export async function getHechosByIds(db: Db, clienteId: ClienteId, ids: readonly string[]): Promise<HechoRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<HechoRow>('SELECT * FROM hechos_verificados WHERE cliente_id = $1 AND id = ANY($2::uuid[]) ORDER BY id', [clienteId, ids]);
  return rows;
}

/** All facts of the client, including expired ones. Agents must use getValidHechos. */
export async function listHechos(db: Db, clienteId: ClienteId): Promise<HechoRow[]> {
  const { rows } = await db.query<HechoRow>(
    'SELECT * FROM hechos_verificados WHERE cliente_id = $1 ORDER BY vigente_desde, id',
    [clienteId],
  );
  return rows;
}

export function updateHecho(
  db: Db,
  clienteId: ClienteId,
  id: string,
  patch: HechoPatch,
  actor: AuditActor,
): Promise<HechoRow | null> {
  return updateClientRow<HechoRow>(db, { tabla: 'hechos_verificados', allowed: UPDATABLE, clienteId, id, patch, actor });
}

export function deleteHecho(db: Db, clienteId: ClienteId, id: string, actor: AuditActor): Promise<boolean> {
  return deleteClientRow(db, { tabla: 'hechos_verificados', clienteId, id, actor });
}

/**
 * Facts valid at `at`: vigente_desde <= at and (no end or at < vigente_hasta).
 * Without `at` it uses the database clock (SQL now()), the same clock that sets the default
 * vigente_desde, so a fact created a moment ago is valid. An explicit `at` is sent as a parameter.
 */
export async function getValidHechos(db: Db, clienteId: ClienteId, at?: Date): Promise<HechoRow[]> {
  const atSql = at ? '$2' : 'now()';
  const { rows } = await db.query<HechoRow>(
    `SELECT * FROM hechos_verificados
     WHERE cliente_id = $1 AND vigente_desde <= ${atSql} AND (vigente_hasta IS NULL OR vigente_hasta > ${atSql})
     ORDER BY vigente_desde, id`,
    at ? [clienteId, at] : [clienteId],
  );
  return rows;
}
