import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { can } from '../auth/permissions.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { assertMicro, microToUsd, usdToMicro, type MicroUsd } from '../presupuesto/money.js';
import { getUserRoles } from '../roles/usuarioRolesRepository.js';

// Prices are USD per 1,000,000 tokens. In TypeScript they are bigint micro-USD per million tokens.

export class PriceNotFoundError extends Error {
  constructor(provider: string, model: string) {
    super(`No price found for ${provider}/${model} at the requested time`);
    this.name = 'PriceNotFoundError';
  }
}

export class PriceActorError extends Error {
  constructor() {
    super('Model prices can only be written by a signed-in user');
    this.name = 'PriceActorError';
  }
}

export class PermissionDeniedError extends Error {
  constructor(readonly action: string) {
    super(`Permission denied: ${action}`);
    this.name = 'PermissionDeniedError';
  }
}

export class PriceExistsError extends Error {
  constructor(provider: string, model: string) {
    super(`A price for ${provider}/${model} with that vigente_desde already exists`);
    this.name = 'PriceExistsError';
  }
}

export interface PrecioModeloRow {
  id: string;
  proveedor: string;
  modelo: string;
  precio_entrada_por_millon: string;
  precio_salida_por_millon: string;
  vigente_desde: Date;
  nota: string | null;
  creado_por: string;
  creado_en: Date;
}

export interface ModelPrice {
  id: string;
  provider: string;
  model: string;
  inputPerMillion: MicroUsd;
  outputPerMillion: MicroUsd;
  vigenteDesde: Date;
  nota: string | null;
}

export interface NewModelPrice {
  provider: string;
  model: string;
  inputPerMillion: MicroUsd;
  outputPerMillion: MicroUsd;
  /** Defaults to now (database clock). */
  vigenteDesde?: Date;
  nota?: string;
}

const COLUMNS = `id, proveedor, modelo, precio_entrada_por_millon::text AS precio_entrada_por_millon,
  precio_salida_por_millon::text AS precio_salida_por_millon, vigente_desde, nota, creado_por, creado_en`;

function toModelPrice(row: PrecioModeloRow): ModelPrice {
  return {
    id: row.id,
    provider: row.proveedor,
    model: row.modelo,
    inputPerMillion: usdToMicro(row.precio_entrada_por_millon),
    outputPerMillion: usdToMicro(row.precio_salida_por_millon),
    vigenteDesde: row.vigente_desde,
    nota: row.nota,
  };
}

/**
 * Writes a new price row (never updates). Needs a signed-in user with the global `manage_budget`
 * permission; audited in the same transaction.
 */
export async function setModelPrice(db: Db, input: NewModelPrice, actor: AuditActor): Promise<ModelPrice> {
  if (actor.tipo !== 'usuario') throw new PriceActorError();
  assertMicro(input.inputPerMillion, 'inputPerMillion');
  assertMicro(input.outputPerMillion, 'outputPerMillion');
  if (!can(await getUserRoles(db, actor.usuarioId), 'manage_budget')) throw new PermissionDeniedError('manage_budget');

  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<PrecioModeloRow>(
      `INSERT INTO precios_modelos
         (proveedor, modelo, precio_entrada_por_millon, precio_salida_por_millon, vigente_desde, nota, creado_por)
       VALUES ($1, $2, $3, $4, coalesce($5, now()), $6, $7)
       ON CONFLICT (proveedor, modelo, vigente_desde) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.provider,
        input.model,
        microToUsd(input.inputPerMillion),
        microToUsd(input.outputPerMillion),
        input.vigenteDesde ?? null,
        input.nota ?? null,
        actor.usuarioId,
      ],
    );
    const row = rows[0];
    if (!row) throw new PriceExistsError(input.provider, input.model);
    await recordAudit(tx, {
      actor,
      accion: 'crear',
      tabla: 'precios_modelos',
      filaId: row.id,
      despues: {
        proveedor: row.proveedor,
        modelo: row.modelo,
        precio_entrada_por_millon: row.precio_entrada_por_millon,
        precio_salida_por_millon: row.precio_salida_por_millon,
        vigente_desde: row.vigente_desde.toISOString(),
        nota: row.nota,
      },
    });
    return toModelPrice(row);
  });
}

/**
 * The price valid at `at`: the latest row with vigente_desde <= at. Without `at` the database clock
 * (now()) is used inside the query, so a price created a moment ago is valid; an explicit `at` is
 * sent as a parameter. Throws PriceNotFoundError when there is none.
 */
export async function getPriceAt(db: Db, provider: string, model: string, at?: Date): Promise<ModelPrice> {
  const atSql = at ? '$3' : 'now()';
  const { rows } = await db.query<PrecioModeloRow>(
    `SELECT ${COLUMNS} FROM precios_modelos
     WHERE proveedor = $1 AND modelo = $2 AND vigente_desde <= ${atSql}
     ORDER BY vigente_desde DESC LIMIT 1`,
    at ? [provider, model, at] : [provider, model],
  );
  if (!rows[0]) throw new PriceNotFoundError(provider, model);
  return toModelPrice(rows[0]);
}

/** Lookup for idempotent seeding: true when any price exists for the provider and model. */
export async function hasAnyPrice(db: Db, provider: string, model: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM precios_modelos WHERE proveedor = $1 AND modelo = $2 LIMIT 1', [provider, model]);
  return rows.length > 0;
}
