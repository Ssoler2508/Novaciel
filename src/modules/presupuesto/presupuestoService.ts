import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { logger } from '../../lib/logger/index.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';
import { assertMicro, microToUsd, usdToMicro, type MicroUsd } from './money.js';

// Budget control (spec 13). All money is bigint micro-dollars here; PostgreSQL holds numeric(18,6)
// and does the sums, so no value ever passes through a JavaScript float.
// Logs carry ids, amounts and counts only, never prompts or model output.

export type BudgetRefusalReason = 'sin_techo' | 'techo_superado' | 'interruptor_global' | 'interruptor_cliente';

export class BudgetRefusedError extends Error {
  constructor(
    readonly reason: BudgetRefusalReason,
    readonly clienteId: string,
  ) {
    super(`Budget authorization refused: ${reason}`);
    this.name = 'BudgetRefusedError';
  }
}

export class AuthorizationNotFoundError extends Error {
  constructor() {
    super('Spend authorization not found');
    this.name = 'AuthorizationNotFoundError';
  }
}

export class AuthorizationStateError extends Error {
  constructor(readonly estado: string, action: 'settle' | 'release') {
    super(`Cannot ${action} an authorization in state "${estado}"`);
    this.name = 'AuthorizationStateError';
  }
}

export interface AuthorizeRequest {
  estimatedCost: MicroUsd;
  purpose: string;
  provider: string;
  model: string;
  /** How long the reservation holds budget before it can be expired. Default 10 minutes. */
  ttlSeconds?: number;
}

export interface SpendAuthorization {
  id: string;
  clienteId: ClienteId;
  /** First day of the UTC month the amount counts against, as YYYY-MM-DD. */
  periodo: string;
  estimatedCost: MicroUsd;
  purpose: string;
  provider: string;
  model: string;
  expiraEn: Date;
}

export interface SettleInput {
  actualCost: MicroUsd;
  inputUnits: number;
  outputUnits: number;
  outcome: 'ok' | 'schema_invalido' | 'error';
}

export interface SpendSummary {
  periodo: string;
  /** Null when the client has neither a ceiling row for the period nor a default. */
  ceiling: MicroUsd | null;
  spent: MicroUsd;
  reserved: MicroUsd;
  remaining: MicroUsd | null;
  /** (spent + reserved) / ceiling, 0 to 100 with two decimals (not money). 100 when the ceiling is 0. */
  percentUsed: number | null;
}

const DEFAULT_TTL_SECONDS = 600;
const PERIOD_RE = /^\d{4}-\d{2}-01$/;

interface AuthorizationRow {
  id: string;
  cliente_id: ClienteId;
  periodo: string;
  monto_estimado: string;
  proposito: string;
  proveedor: string;
  modelo: string;
  expira_en: Date;
  estado: string;
}

const AUTH_COLUMNS = 'id, cliente_id, periodo::text AS periodo, monto_estimado::text AS monto_estimado, proposito, proveedor, modelo, expira_en, estado';

function toAuthorization(row: AuthorizationRow): SpendAuthorization {
  return {
    id: row.id,
    clienteId: row.cliente_id,
    periodo: row.periodo,
    estimatedCost: usdToMicro(row.monto_estimado),
    purpose: row.proposito,
    provider: row.proveedor,
    model: row.modelo,
    expiraEn: row.expira_en,
  };
}

/** Current UTC month start, from the database clock (same clock as expira_en). */
async function currentPeriodo(db: Db): Promise<string> {
  const { rows } = await db.query<{ periodo: string }>(
    `SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS periodo`,
  );
  return rows[0]!.periodo;
}

/** Settled ledger amount plus active (unexpired) reservations for the client and period. */
async function readSpend(db: Db, clienteId: ClienteId, periodo: string): Promise<{ spent: MicroUsd; reserved: MicroUsd }> {
  const { rows } = await db.query<{ spent: string; reserved: string }>(
    `SELECT
       (SELECT coalesce(sum(costo_real), 0) FROM libro_gastos WHERE cliente_id = $1 AND periodo = $2)::text AS spent,
       (SELECT coalesce(sum(monto_estimado), 0) FROM autorizaciones_gasto
         WHERE cliente_id = $1 AND periodo = $2 AND estado = 'reservada' AND expira_en > now())::text AS reserved`,
    [clienteId, periodo],
  );
  return { spent: usdToMicro(rows[0]!.spent), reserved: usdToMicro(rows[0]!.reserved) };
}

type AuthorizeOutcome = { authorization: SpendAuthorization } | { refused: BudgetRefusalReason };

/**
 * Reserves `estimatedCost` against the client's ceiling for the current month, or throws
 * BudgetRefusedError. Safe under concurrency: the client's `topes` row for the period is locked
 * (FOR UPDATE) before spent + reserved are read, so parallel authorizations are serialized.
 * Refusals are audited too; the error is thrown after the transaction ends so that audit row commits.
 */
export async function authorize(
  db: Db,
  clienteId: ClienteId,
  request: AuthorizeRequest,
  actor: AuditActor,
): Promise<SpendAuthorization> {
  assertMicro(request.estimatedCost, 'estimatedCost');
  const ttl = request.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('ttlSeconds must be a positive integer');

  const outcome = await runInTransaction<AuthorizeOutcome>(db, async (tx) => {
    const refuse = async (reason: BudgetRefusalReason, extra: Record<string, unknown> = {}): Promise<AuthorizeOutcome> => {
      await recordAudit(tx, {
        actor,
        accion: 'rechazar_gasto',
        tabla: 'autorizaciones_gasto',
        filaId: clienteId,
        clienteId,
        despues: {
          motivo: reason,
          monto_estimado: microToUsd(request.estimatedCost),
          proposito: request.purpose,
          proveedor: request.provider,
          modelo: request.model,
          ...extra,
        },
      });
      return { refused: reason };
    };

    const globalRow = await tx.query<{ gasto_habilitado: boolean }>('SELECT gasto_habilitado FROM interruptor_global');
    // A missing global row must not mean "spending allowed".
    if (!globalRow.rows[0]?.gasto_habilitado) return refuse('interruptor_global');

    const config = await tx.query<{ gasto_habilitado: boolean }>(
      'SELECT gasto_habilitado FROM configuracion_gasto_cliente WHERE cliente_id = $1',
      [clienteId],
    );
    if (config.rows[0] && !config.rows[0].gasto_habilitado) return refuse('interruptor_cliente');

    const periodo = await currentPeriodo(tx);

    // First authorization of the period: create the ceiling row from the client's default, if any.
    const created = await tx.query<{ id: string; monto_techo: string }>(
      `INSERT INTO topes (cliente_id, periodo, monto_techo)
       SELECT cliente_id, $2::date, techo_mensual_defecto FROM configuracion_gasto_cliente
       WHERE cliente_id = $1 AND techo_mensual_defecto IS NOT NULL
       ON CONFLICT (cliente_id, periodo) DO NOTHING
       RETURNING id, monto_techo::text AS monto_techo`,
      [clienteId, periodo],
    );
    if (created.rows[0]) {
      await recordAudit(tx, {
        actor,
        accion: 'crear',
        tabla: 'topes',
        filaId: created.rows[0].id,
        clienteId,
        despues: { periodo, monto_techo: created.rows[0].monto_techo, origen: 'techo_mensual_defecto' },
      });
    }

    // The lock that serializes all authorizations of this client and period.
    const tope = await tx.query<{ monto_techo: string }>(
      'SELECT monto_techo::text AS monto_techo FROM topes WHERE cliente_id = $1 AND periodo = $2 FOR UPDATE',
      [clienteId, periodo],
    );
    if (!tope.rows[0]) return refuse('sin_techo');
    const ceiling = usdToMicro(tope.rows[0].monto_techo);

    const { spent, reserved } = await readSpend(tx, clienteId, periodo);
    if (spent + reserved + request.estimatedCost > ceiling) {
      return refuse('techo_superado', {
        techo: microToUsd(ceiling),
        gastado: microToUsd(spent),
        reservado: microToUsd(reserved),
      });
    }

    const { rows } = await tx.query<AuthorizationRow>(
      `INSERT INTO autorizaciones_gasto (cliente_id, periodo, monto_estimado, proposito, proveedor, modelo, expira_en)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
       RETURNING ${AUTH_COLUMNS}`,
      [clienteId, periodo, microToUsd(request.estimatedCost), request.purpose, request.provider, request.model, ttl],
    );
    const row = rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'autorizar',
      tabla: 'autorizaciones_gasto',
      filaId: row.id,
      clienteId,
      despues: {
        periodo,
        monto_estimado: row.monto_estimado,
        proposito: row.proposito,
        proveedor: row.proveedor,
        modelo: row.modelo,
        expira_en: row.expira_en.toISOString(),
      },
    });
    return { authorization: toAuthorization(row) };
  });

  if ('refused' in outcome) throw new BudgetRefusedError(outcome.refused, clienteId);
  return outcome.authorization;
}

/**
 * Closes a reservation with the real cost and writes the ledger row, in one transaction.
 * Works once per authorization. A reservation that expired (vencida) can still be settled: if the
 * call finished late the money was spent and the ledger must say so. A released one cannot.
 * The actual cost may exceed the estimate; it is recorded anyway and a warning is logged.
 * The authorization's own cliente_id filters the update, so another client's id finds nothing.
 */
export async function settle(db: Db, authorization: SpendAuthorization, input: SettleInput, actor: AuditActor): Promise<void> {
  assertMicro(input.actualCost, 'actualCost');
  for (const [label, value] of [['inputUnits', input.inputUnits], ['outputUnits', input.outputUnits]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  }

  await runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<AuthorizationRow & { estado_previo: string }>(
      `UPDATE autorizaciones_gasto a SET estado = 'liquidada', liquidada_en = now()
       FROM (SELECT id, estado FROM autorizaciones_gasto
             WHERE id = $1 AND cliente_id = $2 AND estado IN ('reservada', 'vencida') FOR UPDATE) prev
       WHERE a.id = prev.id
       RETURNING a.id, a.cliente_id, a.periodo::text AS periodo, a.monto_estimado::text AS monto_estimado,
                 a.proposito, a.proveedor, a.modelo, a.expira_en, a.estado, prev.estado AS estado_previo`,
      [authorization.id, authorization.clienteId],
    );
    const row = rows[0];
    if (!row) throw await missingOrWrongState(tx, authorization, 'settle');

    await tx.query(
      `INSERT INTO libro_gastos
         (cliente_id, autorizacion_id, periodo, proveedor, modelo, unidades_entrada, unidades_salida, costo_real, proposito, resultado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.cliente_id,
        row.id,
        row.periodo,
        row.proveedor,
        row.modelo,
        input.inputUnits,
        input.outputUnits,
        microToUsd(input.actualCost),
        row.proposito,
        input.outcome,
      ],
    );
    await recordAudit(tx, {
      actor,
      accion: 'liquidar',
      tabla: 'autorizaciones_gasto',
      filaId: row.id,
      clienteId: row.cliente_id,
      antes: { estado: row.estado_previo },
      despues: {
        estado: 'liquidada',
        monto_estimado: row.monto_estimado,
        costo_real: microToUsd(input.actualCost),
        unidades_entrada: input.inputUnits,
        unidades_salida: input.outputUnits,
        resultado: input.outcome,
      },
    });

    const estimated = usdToMicro(row.monto_estimado);
    if (input.actualCost > estimated) {
      logger.warn(
        {
          clienteId: row.cliente_id,
          authorizationId: row.id,
          provider: row.proveedor,
          model: row.modelo,
          purpose: row.proposito,
          estimatedCost: microToUsd(estimated),
          actualCost: microToUsd(input.actualCost),
        },
        'actual cost exceeded the authorized estimate',
      );
    }
  });
}

/** Frees a reservation for a call that never happened. Only a `reservada` one can be released. */
export async function release(db: Db, authorization: SpendAuthorization, actor: AuditActor): Promise<void> {
  await runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<AuthorizationRow>(
      `UPDATE autorizaciones_gasto SET estado = 'liberada'
       WHERE id = $1 AND cliente_id = $2 AND estado = 'reservada'
       RETURNING ${AUTH_COLUMNS}`,
      [authorization.id, authorization.clienteId],
    );
    const row = rows[0];
    if (!row) throw await missingOrWrongState(tx, authorization, 'release');
    await recordAudit(tx, {
      actor,
      accion: 'liberar',
      tabla: 'autorizaciones_gasto',
      filaId: row.id,
      clienteId: row.cliente_id,
      antes: { estado: 'reservada' },
      despues: { estado: 'liberada', monto_estimado: row.monto_estimado },
    });
  });
}

async function missingOrWrongState(db: Db, authorization: SpendAuthorization, action: 'settle' | 'release'): Promise<Error> {
  const { rows } = await db.query<{ estado: string }>(
    'SELECT estado FROM autorizaciones_gasto WHERE id = $1 AND cliente_id = $2',
    [authorization.id, authorization.clienteId],
  );
  return rows[0] ? new AuthorizationStateError(rows[0].estado, action) : new AuthorizationNotFoundError();
}

/**
 * Marks reservations past `expira_en` as `vencida`, so a crash cannot hold budget forever.
 * Global (every client), run by the scheduler as the system. Returns how many were expired.
 */
export async function expireStaleReservations(db: Db): Promise<number> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<AuthorizationRow>(
      `UPDATE autorizaciones_gasto SET estado = 'vencida'
       WHERE estado = 'reservada' AND expira_en <= now()
       RETURNING ${AUTH_COLUMNS}`,
    );
    for (const row of rows) {
      await recordAudit(tx, {
        actor: { tipo: 'sistema' },
        accion: 'vencer',
        tabla: 'autorizaciones_gasto',
        filaId: row.id,
        clienteId: row.cliente_id,
        antes: { estado: 'reservada' },
        despues: { estado: 'vencida', monto_estimado: row.monto_estimado },
      });
    }
    return rows.length;
  });
}

/**
 * Ceiling, spent, reserved, remaining and percentage for a client and period (default: current
 * UTC month). Read-only: it never creates the ceiling row. Step 11 uses it for the 80% and 100% alerts.
 */
export async function getSpendSummary(db: Db, clienteId: ClienteId, periodo?: string): Promise<SpendSummary> {
  if (periodo !== undefined && !PERIOD_RE.test(periodo)) throw new Error('periodo must be the first day of a month (YYYY-MM-01)');
  const period = periodo ?? (await currentPeriodo(db));

  const { rows } = await db.query<{ techo: string | null }>(
    `SELECT coalesce(
        (SELECT monto_techo FROM topes WHERE cliente_id = $1 AND periodo = $2),
        (SELECT techo_mensual_defecto FROM configuracion_gasto_cliente WHERE cliente_id = $1)
      )::text AS techo`,
    [clienteId, period],
  );
  const ceiling = rows[0]!.techo === null ? null : usdToMicro(rows[0]!.techo);
  const { spent, reserved } = await readSpend(db, clienteId, period);
  if (ceiling === null) return { periodo: period, ceiling, spent, reserved, remaining: null, percentUsed: null };

  const used = spent + reserved;
  const remaining = ceiling > used ? ceiling - used : 0n;
  // Basis points with bigint division (floor), then shown as a percentage with two decimals.
  const percentUsed = ceiling === 0n ? 100 : Number((used * 10_000n) / ceiling) / 100;
  return { periodo: period, ceiling, spent, reserved, remaining, percentUsed };
}
