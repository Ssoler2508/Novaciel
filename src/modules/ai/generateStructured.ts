import type { Logger } from 'pino';
import type { ZodType } from 'zod';
import type { Db } from '../../db/types.js';
import type { AlertSink } from '../../lib/ai/alerts.js';
import { modelForPurpose, tierForPurpose, type Purpose } from '../../lib/ai/modelTiers.js';
import { LLMProviderError, type LLMProvider, type LLMResponse } from '../../lib/ai/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import type { AuditActor } from '../auditoria/recordAudit.js';
import { computeCost, estimateCost } from '../precios/costEstimation.js';
import { microToUsd, type MicroUsd } from '../presupuesto/money.js';
import { authorize, release, settle, type SpendAuthorization } from '../presupuesto/presupuestoService.js';
import type { ClienteId } from '../shared/clienteId.js';

// Structured generation: every paid call is estimated, authorized, made, settled, and its output
// validated against a zod schema (rule 8). One retry, then an alert. Prompts and outputs may
// contain client data, so logs, alerts and errors carry metadata only (client, purpose, model,
// token counts, cost, outcome).

export interface GenerateStructuredDeps {
  db: Db;
  provider: LLMProvider;
  alerts: AlertSink;
  logger?: Logger;
}

export interface GenerateStructuredRequest<T> {
  clienteId: ClienteId;
  /** What the call is for; recorded in the ledger. It alone decides the model tier. */
  purpose: Purpose;
  schema: ZodType<T>;
  prompt: { system: string; user: string };
  maxOutputTokens: number;
  actor: AuditActor;
}

export interface GenerateStructuredResult<T> {
  data: T;
  /** 1, or 2 when the first output failed validation. */
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  /** Total real cost of all attempts, micro-USD. */
  cost: MicroUsd;
}

export class SchemaValidationError extends Error {
  constructor(
    readonly purpose: Purpose,
    readonly attempts: number,
  ) {
    super(`Model output did not match the expected schema after ${attempts} attempts (purpose: ${purpose})`);
    this.name = 'SchemaValidationError';
  }
}

export const RETRY_NOTE =
  'Your previous reply did not match the required format. Reply again with valid JSON only, matching the requested structure exactly.';

const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/** Parses the text as JSON (tolerating a surrounding code fence) and validates it. */
function parseAndValidate<T>(text: string, schema: ZodType<T>): { ok: true; data: T } | { ok: false } {
  const trimmed = text.trim();
  const body = FENCE_RE.exec(trimmed)?.[1] ?? trimmed;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false };
  }
  const result = schema.safeParse(json);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}

interface Attempt<T> {
  usage: { inputTokens: number; outputTokens: number; cost: MicroUsd };
  data: { ok: true; data: T } | { ok: false };
}

export async function generateStructured<T>(
  deps: GenerateStructuredDeps,
  request: GenerateStructuredRequest<T>,
): Promise<GenerateStructuredResult<T>> {
  const log = deps.logger ?? defaultLogger;
  const { db, provider } = deps;
  const tier = tierForPurpose(request.purpose);
  const model = modelForPurpose(provider, request.purpose);
  const meta = { clienteId: request.clienteId, purpose: request.purpose, tier, provider: provider.name, model };

  const attemptOnce = async (user: string, attemptNumber: number): Promise<Attempt<T>> => {
    // No tokenizer: a token covers at least one UTF-8 byte, so the byte length is a safe upper bound.
    const maxInputTokens = Buffer.byteLength(request.prompt.system) + Buffer.byteLength(user);
    // Throws PriceNotFoundError for an unpriced model, before anything is authorized or sent.
    const estimatedCost = await estimateCost(db, {
      provider: provider.name,
      model,
      maxInputTokens,
      maxOutputTokens: request.maxOutputTokens,
    });
    // Throws BudgetRefusedError; the provider is never called.
    const authorization = await authorize(
      db,
      request.clienteId,
      { estimatedCost, purpose: request.purpose, provider: provider.name, model },
      request.actor,
    );

    const started = Date.now();
    let response: LLMResponse;
    try {
      response = await provider.generate({
        system: request.prompt.system,
        messages: [{ role: 'user', content: user }],
        maxOutputTokens: request.maxOutputTokens,
        tier,
      });
    } catch (error) {
      await closeAfterProviderError(deps, request, authorization, model, error, log);
      log.error(
        { ...meta, attempt: attemptNumber, durationMs: Date.now() - started, outcome: 'error', errorName: errorName(error) },
        'llm call failed',
      );
      throw error;
    }

    const cost = await computeCost(db, {
      provider: provider.name,
      model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });
    const parsed = parseAndValidate(response.text, request.schema);
    const outcome = parsed.ok ? 'ok' : 'schema_invalido';
    await settle(
      db,
      authorization,
      { actualCost: cost, inputUnits: response.inputTokens, outputUnits: response.outputTokens, outcome },
      request.actor,
    );
    log.info(
      {
        ...meta,
        attempt: attemptNumber,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cost: microToUsd(cost),
        durationMs: Date.now() - started,
        outcome,
        // The ledger keeps the id we sent and priced; the API may echo a dated variant of it.
        ...(response.model !== model ? { responseModel: response.model } : {}),
      },
      'llm call settled',
    );
    return { usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens, cost }, data: parsed };
  };

  const first = await attemptOnce(request.prompt.user, 1);
  if (first.data.ok) return result(first.data.data, 1, [first.usage]);

  // The retry is a new paid call with its own estimate and authorization.
  const second = await attemptOnce(`${request.prompt.user}\n\n${RETRY_NOTE}`, 2);
  if (second.data.ok) return result(second.data.data, 2, [first.usage, second.usage]);

  await deps.alerts.alert({ code: 'llm_schema_invalid', ...meta, attempts: 2 });
  throw new SchemaValidationError(request.purpose, 2);
}

function result<T>(data: T, attempts: number, usages: Attempt<T>['usage'][]): GenerateStructuredResult<T> {
  return {
    data,
    attempts,
    inputTokens: usages.reduce((sum, u) => sum + u.inputTokens, 0),
    outputTokens: usages.reduce((sum, u) => sum + u.outputTokens, 0),
    cost: usages.reduce((sum, u) => sum + u.cost, 0n),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * The provider failed: charge what it reports as used (outcome "error"), or give the reservation
 * back when it reports nothing. A failure here is logged and never hides the provider's error.
 */
async function closeAfterProviderError<T>(
  deps: GenerateStructuredDeps,
  request: GenerateStructuredRequest<T>,
  authorization: SpendAuthorization,
  model: string,
  error: unknown,
  log: Logger,
): Promise<void> {
  const { db, provider } = deps;
  try {
    if (error instanceof LLMProviderError && error.usage) {
      const cost = await computeCost(db, {
        provider: provider.name,
        model,
        inputTokens: error.usage.inputTokens,
        outputTokens: error.usage.outputTokens,
      });
      await settle(
        db,
        authorization,
        { actualCost: cost, inputUnits: error.usage.inputTokens, outputUnits: error.usage.outputTokens, outcome: 'error' },
        request.actor,
      );
    } else {
      await release(db, authorization, request.actor);
    }
  } catch (closeError) {
    log.error(
      { clienteId: request.clienteId, purpose: request.purpose, authorizationId: authorization.id, errorName: errorName(closeError) },
      'could not close the spend authorization after a provider error',
    );
  }
}
