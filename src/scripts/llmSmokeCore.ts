import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../db/types.js';
import type { AlertSink } from '../lib/ai/alerts.js';
import { ClaudeProviderError } from '../lib/ai/claudeProvider.js';
import { modelForPurpose, type ModelTier, type Purpose } from '../lib/ai/modelTiers.js';
import type { LLMProvider } from '../lib/ai/types.js';
import { generateStructured, SchemaValidationError } from '../modules/ai/generateStructured.js';
import { PriceNotFoundError } from '../modules/precios/preciosRepository.js';
import { microToUsd, usdToMicro, type MicroUsd } from '../modules/presupuesto/money.js';
import { BudgetRefusedError, getSpendSummary, type SpendSummary } from '../modules/presupuesto/presupuestoService.js';
import type { ClienteId } from '../modules/shared/clienteId.js';

export const SMOKE_PURPOSES = { heavy: 'smoke_test_pesado', light: 'smoke_test_ligero' } as const satisfies Record<ModelTier, Purpose>;
export const SMOKE_PROMPT = { system: 'You reply with JSON only.', user: 'Reply with exactly this JSON: {"ok": true}' };
const SMOKE_SCHEMA = z.object({ ok: z.boolean() });
const SMOKE_MAX_OUTPUT_TOKENS = 64;

export interface TierSmokeReport {
  tier: ModelTier;
  purpose: Purpose;
  outcome: 'ok' | 'schema_invalido' | 'error' | 'refused';
  /** A short, content-free reason for failures. */
  reason: string | null;
  /** The model id the call was sent to and priced with. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: MicroUsd;
}

export interface SmokeReport {
  /** Heavy first, then light. */
  tiers: TierSmokeReport[];
  budget: SpendSummary;
}

/** Tokens and cost of the ledger rows one call wrote (id greater than `afterId`). */
async function ledgerTotals(db: Db, clienteId: ClienteId, afterId: string) {
  const { rows } = await db.query<{ input: string; output: string; cost: string }>(
    `SELECT coalesce(sum(unidades_entrada), 0)::text AS input, coalesce(sum(unidades_salida), 0)::text AS output,
            coalesce(sum(costo_real), 0)::text AS cost
     FROM libro_gastos WHERE cliente_id = $1 AND id > $2`,
    [clienteId, afterId],
  );
  const row = rows[0]!;
  return { inputTokens: Number(row.input), outputTokens: Number(row.output), cost: usdToMicro(row.cost) };
}

async function smokeTier(
  deps: { db: Db; provider: LLMProvider; alerts: AlertSink; clienteId: ClienteId; logger?: Logger },
  tier: ModelTier,
): Promise<TierSmokeReport> {
  const { db, provider, clienteId } = deps;
  const purpose = SMOKE_PURPOSES[tier];
  const model = modelForPurpose(provider, purpose);
  const before = (
    await db.query<{ id: string }>('SELECT coalesce(max(id), 0)::text AS id FROM libro_gastos WHERE cliente_id = $1', [clienteId])
  ).rows[0]!.id;

  let reason: string | null = null;
  let outcome: TierSmokeReport['outcome'] = 'ok';
  try {
    await generateStructured(
      { db, provider, alerts: deps.alerts, ...(deps.logger ? { logger: deps.logger } : {}) },
      {
        clienteId,
        purpose,
        schema: SMOKE_SCHEMA,
        prompt: SMOKE_PROMPT,
        maxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS,
        actor: { tipo: 'sistema' },
      },
    );
  } catch (error) {
    if (error instanceof BudgetRefusedError) {
      outcome = 'refused';
      reason = `budget refused: ${error.reason}`;
    } else if (error instanceof PriceNotFoundError) {
      outcome = 'error';
      reason = `no price for ${provider.name}/${model}: enter it first (npm run set-price)`;
    } else if (error instanceof SchemaValidationError) {
      outcome = 'schema_invalido';
      reason = 'the model output did not match the schema after 2 attempts';
    } else if (error instanceof ClaudeProviderError) {
      outcome = 'error';
      reason = `provider error: ${error.kind}${error.status ? ` (status ${error.status})` : ''}`;
    } else {
      outcome = 'error';
      reason = `unexpected error: ${error instanceof Error ? error.name : 'unknown'}`;
    }
  }

  const totals = await ledgerTotals(db, clienteId, before);
  return { tier, purpose, outcome, reason, model, ...totals };
}

/**
 * Two tiny generateStructured calls, one per model tier, each through the whole path (estimate,
 * authorize, call, settle, validate). Each report is read from the ledger rows its call wrote, and
 * never contains the prompt, the output or any key.
 */
export async function runLlmSmoke(deps: {
  db: Db;
  provider: LLMProvider;
  alerts: AlertSink;
  clienteId: ClienteId;
  logger?: Logger;
}): Promise<SmokeReport> {
  const tiers: TierSmokeReport[] = [];
  for (const tier of ['heavy', 'light'] as const) tiers.push(await smokeTier(deps, tier));
  return { tiers, budget: await getSpendSummary(deps.db, deps.clienteId) };
}

const usd = (value: MicroUsd | null) => (value === null ? 'none' : `USD ${microToUsd(value)}`);

/** The only text the script prints: per tier model, tokens, cost and outcome, then the remaining budget. */
export function formatSmokeReport(report: SmokeReport): string[] {
  const { budget } = report;
  const percent = budget.percentUsed === null ? '' : ` (${budget.percentUsed}% used)`;
  const lines = report.tiers.flatMap((t) => [
    `[${t.tier}] model: ${t.model}`,
    `[${t.tier}] tokens: input ${t.inputTokens}, output ${t.outputTokens}`,
    `[${t.tier}] cost: ${usd(t.cost)}`,
    `[${t.tier}] outcome: ${t.outcome}${t.reason ? ` (${t.reason})` : ''}`,
  ]);
  lines.push(
    `budget ${budget.periodo}: ceiling ${usd(budget.ceiling)}, spent ${usd(budget.spent)}, reserved ${usd(budget.reserved)}, remaining ${usd(budget.remaining)}${percent}`,
  );
  return lines;
}
