import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { can } from '../auth/permissions.js';
import { PermissionDeniedError, PriceActorError } from '../precios/preciosRepository.js';
import { getUserRoles } from '../roles/usuarioRolesRepository.js';
import type { ClienteId } from '../shared/clienteId.js';
import { assertMicro, microToUsd, usdToMicro, type MicroUsd } from './money.js';

// Budget administration (Step 11, checkpoint B): the monthly ceiling, the client switch and the global
// switch, plus the read of the spend ledger. Every write needs a signed-in user holding the global
// `manage_budget` permission (administrador_novaciel) and is audited in the same transaction, like the
// price writes. Prices live in preciosRepository (`manage_prices`). The routes call these functions; the
// permission is checked here too so no other caller can skip it.

export class PastPeriodError extends Error {
  constructor() {
    super('The ceiling of a past month cannot be changed');
    this.name = 'PastPeriodError';
  }
}

export class ClientNotFoundError extends Error {
  constructor() {
    super('Client not found');
    this.name = 'ClientNotFoundError';
  }
}

const PERIOD_RE = /^\d{4}-\d{2}-01$/;

async function assertManageBudget(db: Db, actor: AuditActor): Promise<string> {
  if (actor.tipo !== 'usuario') throw new PriceActorError();
  if (!can(await getUserRoles(db, actor.usuarioId), 'manage_budget')) throw new PermissionDeniedError('manage_budget');
  return actor.usuarioId;
}

async function assertClientExists(db: Db, clienteId: ClienteId): Promise<void> {
  const { rows } = await db.query('SELECT 1 FROM clientes WHERE id = $1', [clienteId]);
  if (rows.length === 0) throw new ClientNotFoundError();
}

export interface CeilingChange {
  periodo: string;
  /** Null when the row did not exist before. */
  antes: MicroUsd | null;
  despues: MicroUsd;
  /** True when the new ceiling is below what is already spent plus reserved (new paid calls are then refused). */
  porDebajoDelGasto: boolean;
}

/**
 * Sets the ceiling of a client for the current or a future month (UTC). A past month is refused
 * (PastPeriodError): its ledger is closed history. A ceiling below what is already spent is allowed
 * and flagged in the audit row; the budget service then refuses new authorizations. The topes row is
 * locked first, so a concurrent authorization sees either the old or the new ceiling, never a mix.
 */
export async function setMonthlyCeiling(
  db: Db,
  clienteId: ClienteId,
  input: { periodo: string; monto: MicroUsd },
  actor: AuditActor,
): Promise<CeilingChange> {
  const userId = await assertManageBudget(db, actor);
  assertMicro(input.monto, 'monto');
  if (!PERIOD_RE.test(input.periodo)) throw new Error('periodo must be the first day of a month (YYYY-MM-01)');

  return runInTransaction(db, async (tx) => {
    await assertClientExists(tx, clienteId);
    const past = await tx.query<{ past: boolean }>(
      `SELECT $1::date < date_trunc('month', now() AT TIME ZONE 'UTC')::date AS past`,
      [input.periodo],
    );
    if (past.rows[0]!.past) throw new PastPeriodError();

    const prev = await tx.query<{ id: string; monto: string }>(
      'SELECT id, monto_techo::text AS monto FROM topes WHERE cliente_id = $1 AND periodo = $2 FOR UPDATE',
      [clienteId, input.periodo],
    );
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO topes (cliente_id, periodo, monto_techo, creado_por, actualizado_por)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (cliente_id, periodo)
       DO UPDATE SET monto_techo = EXCLUDED.monto_techo, actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()
       RETURNING id`,
      [clienteId, input.periodo, microToUsd(input.monto), userId],
    );
    const { rows: used } = await tx.query<{ used: string }>(
      `SELECT (
         (SELECT coalesce(sum(costo_real), 0) FROM libro_gastos WHERE cliente_id = $1 AND periodo = $2) +
         (SELECT coalesce(sum(monto_estimado), 0) FROM autorizaciones_gasto
           WHERE cliente_id = $1 AND periodo = $2 AND estado = 'reservada' AND expira_en > now())
       )::text AS used`,
      [clienteId, input.periodo],
    );
    const porDebajoDelGasto = input.monto < usdToMicro(used[0]!.used);
    await recordAudit(tx, {
      actor,
      accion: prev.rows[0] ? 'actualizar' : 'crear',
      tabla: 'topes',
      filaId: rows[0]!.id,
      clienteId,
      antes: prev.rows[0] ? { periodo: input.periodo, monto_techo: prev.rows[0].monto } : null,
      despues: { periodo: input.periodo, monto_techo: microToUsd(input.monto), por_debajo_del_gasto: porDebajoDelGasto },
    });
    return {
      periodo: input.periodo,
      antes: prev.rows[0] ? usdToMicro(prev.rows[0].monto) : null,
      despues: input.monto,
      porDebajoDelGasto,
    };
  });
}

/** Turns one client's spending on or off. Creates the settings row if needed (without a default ceiling). */
export async function setClientSpendSwitch(
  db: Db,
  clienteId: ClienteId,
  habilitado: boolean,
  actor: AuditActor,
): Promise<{ antes: boolean; despues: boolean }> {
  const userId = await assertManageBudget(db, actor);
  return runInTransaction(db, async (tx) => {
    await assertClientExists(tx, clienteId);
    const prev = await tx.query<{ gasto_habilitado: boolean }>(
      'SELECT gasto_habilitado FROM configuracion_gasto_cliente WHERE cliente_id = $1 FOR UPDATE',
      [clienteId],
    );
    await tx.query(
      `INSERT INTO configuracion_gasto_cliente (cliente_id, gasto_habilitado, actualizado_por)
       VALUES ($1, $2, $3)
       ON CONFLICT (cliente_id)
       DO UPDATE SET gasto_habilitado = EXCLUDED.gasto_habilitado, actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()`,
      [clienteId, habilitado, userId],
    );
    const antes = prev.rows[0]?.gasto_habilitado ?? true;
    await recordAudit(tx, {
      actor,
      accion: 'actualizar',
      tabla: 'configuracion_gasto_cliente',
      filaId: clienteId,
      clienteId,
      antes: { gasto_habilitado: antes },
      despues: { gasto_habilitado: habilitado },
    });
    return { antes, despues: habilitado };
  });
}

/** Turns all paid spending on or off. Audited with no client (global event). */
export async function setGlobalSpendSwitch(db: Db, habilitado: boolean, actor: AuditActor): Promise<{ antes: boolean; despues: boolean }> {
  const userId = await assertManageBudget(db, actor);
  return runInTransaction(db, async (tx) => {
    const prev = await tx.query<{ gasto_habilitado: boolean }>('SELECT gasto_habilitado FROM interruptor_global FOR UPDATE');
    if (!prev.rows[0]) throw new Error('interruptor_global row is missing');
    await tx.query('UPDATE interruptor_global SET gasto_habilitado = $1, actualizado_por = $2, actualizado_en = now()', [habilitado, userId]);
    await recordAudit(tx, {
      actor,
      accion: 'actualizar',
      tabla: 'interruptor_global',
      filaId: 'global',
      antes: { gasto_habilitado: prev.rows[0].gasto_habilitado },
      despues: { gasto_habilitado: habilitado },
    });
    return { antes: prev.rows[0].gasto_habilitado, despues: habilitado };
  });
}

/** Both switches and the client's default ceiling, read-only. A missing client row means enabled. */
export async function getSwitches(
  db: Db,
  clienteId: ClienteId,
): Promise<{ global: boolean; cliente: boolean; techoMensualDefecto: MicroUsd | null }> {
  const { rows } = await db.query<{ global: boolean | null; cliente: boolean | null; techo: string | null }>(
    `SELECT (SELECT gasto_habilitado FROM interruptor_global) AS global,
            (SELECT gasto_habilitado FROM configuracion_gasto_cliente WHERE cliente_id = $1) AS cliente,
            (SELECT techo_mensual_defecto::text FROM configuracion_gasto_cliente WHERE cliente_id = $1) AS techo`,
    [clienteId],
  );
  const r = rows[0]!;
  // A missing global row must not mean "spending allowed" (same rule as the budget service).
  return { global: r.global ?? false, cliente: r.cliente ?? true, techoMensualDefecto: r.techo === null ? null : usdToMicro(r.techo) };
}

export const LEDGER_MAX_LIMIT = 200;
export const LEDGER_DEFAULT_LIMIT = 50;

/** One ledger row as the panel sees it: ids, codes and numbers only. No prompt, no response, no content. */
export interface LedgerEntry {
  id: string;
  proposito: string;
  proveedor: string;
  modelo: string;
  unidad: string;
  unidadesEntrada: string;
  unidadesSalida: string;
  costoReal: string;
  resultado: 'ok' | 'schema_invalido' | 'error';
  creadoEn: Date;
}

/**
 * The ledger of a client and month, newest first. Keyset pagination on the identity id (a total, stable
 * order that also matches the (cliente_id, periodo) index): pass the last id seen as `before`.
 * `limit` is clamped to 1..LEDGER_MAX_LIMIT. Always filtered by cliente_id.
 */
export async function listLedger(
  db: Db,
  clienteId: ClienteId,
  query: { periodo: string; limit?: number; before?: string },
): Promise<{ items: LedgerEntry[]; next: string | null }> {
  if (!PERIOD_RE.test(query.periodo)) throw new Error('periodo must be the first day of a month (YYYY-MM-01)');
  if (query.before !== undefined && !/^\d{1,18}$/.test(query.before)) throw new Error('before must be a ledger id');
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? LEDGER_DEFAULT_LIMIT), 1), LEDGER_MAX_LIMIT);
  const { rows } = await db.query<{
    id: string;
    proposito: string;
    proveedor: string;
    modelo: string;
    unidad: string;
    unidades_entrada: string;
    unidades_salida: string;
    costo: string;
    resultado: LedgerEntry['resultado'];
    creado_en: Date;
  }>(
    `SELECT id::text AS id, proposito, proveedor, modelo, unidad, unidades_entrada::text AS unidades_entrada,
            unidades_salida::text AS unidades_salida, costo_real::text AS costo, resultado, creado_en
     FROM libro_gastos
     WHERE cliente_id = $1 AND periodo = $2 AND ($3::bigint IS NULL OR id < $3::bigint)
     ORDER BY id DESC LIMIT $4`,
    [clienteId, query.periodo, query.before ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    next: rows.length > limit ? page[page.length - 1]!.id : null,
    items: page.map((r) => ({
      id: r.id,
      proposito: r.proposito,
      proveedor: r.proveedor,
      modelo: r.modelo,
      unidad: r.unidad,
      unidadesEntrada: r.unidades_entrada,
      unidadesSalida: r.unidades_salida,
      costoReal: r.costo,
      resultado: r.resultado,
      creadoEn: r.creado_en,
    })),
  };
}
