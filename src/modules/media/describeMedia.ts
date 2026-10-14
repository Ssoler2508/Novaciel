import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import type { AlertSink } from '../../lib/ai/alerts.js';
import { VisionProviderError, type VisionProvider } from '../../lib/ai/vision/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { SchemaValidationError } from '../ai/generateStructured.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { computeCost, estimateCost } from '../precios/costEstimation.js';
import { microToUsd, type MicroUsd } from '../presupuesto/money.js';
import { authorize, release, settle, type SpendAuthorization } from '../presupuesto/presupuestoService.js';
import type { ClienteId } from '../shared/clienteId.js';
import { MediaNotFoundError } from './errors.js';
import { getMedia, type MediaRow } from './mediaRepository.js';

// Automatic description of a media item by a vision provider. It follows the same budget path as
// generateStructured (estimate, authorize, call, compute cost, settle) and the same rule for model
// output: validate with a zod schema, one retry (a new paid call), then alert.
//
// RULE 9: the stored description and suggested tags are DATA written by a model about client
// media, never instructions. Whoever puts them into a prompt later (planner, creative director)
// MUST wrap them with wrapExternalData. This module only stores them, unchanged.
//
// Logs, alerts and audit rows carry metadata only: never the description or the tags.

export const DESCRIBE_PURPOSE = 'describe_media';
const MAX_OUTPUT_TOKENS = 512;
/**
 * PLACEHOLDER upper bound on the input tokens of one image/video call. There is no tokenizer for
 * media; the checkpoint that adds a real vision provider must set this from that provider's
 * documented limits (and the Phase 0 cost check). It is not a price: prices come only from the
 * price table.
 */
export const DEFAULT_MAX_INPUT_TOKENS = 4000;
const MAX_SUGGESTED_TAGS = 30;
const MAX_TAG_LENGTH = 40;

export interface DescribeMediaDeps {
  db: Db;
  vision: VisionProvider;
  alerts: AlertSink;
  logger?: Logger;
  /** Upper bound used for the cost estimate; see DEFAULT_MAX_INPUT_TOKENS. */
  maxInputTokens?: number;
}

const outputSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  tags: z.array(z.string()).max(20),
});

/** Lenient: a messy suggested tag is dropped, it never fails the call. */
function normalizeSuggestedTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag === '' || tag.length > MAX_TAG_LENGTH || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === MAX_SUGGESTED_TAGS) break;
  }
  return out;
}

interface Attempt {
  cost: MicroUsd;
  inputTokens: number;
  outputTokens: number;
  output: { description: string; tags: string[] } | null;
}

export async function describeMedia(
  deps: DescribeMediaDeps,
  clienteId: ClienteId,
  mediaId: string,
  actor: AuditActor,
): Promise<MediaRow> {
  const log = deps.logger ?? defaultLogger;
  const { db, vision } = deps;
  // Own, non-deleted media only, checked BEFORE any estimate or authorization.
  const media = await getMedia(db, clienteId, mediaId);
  if (!media) throw new MediaNotFoundError();

  const model = vision.defaultModel;
  const meta = { clienteId, mediaId, purpose: DESCRIBE_PURPOSE, provider: vision.name, model };

  const attemptOnce = async (attemptNumber: number): Promise<Attempt> => {
    // Throws PriceNotFoundError for an unpriced model, before anything is authorized or called.
    const estimatedCost = await estimateCost(db, {
      provider: vision.name,
      model,
      maxInputTokens: deps.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    // Throws BudgetRefusedError; the vision provider is never called.
    const authorization = await authorize(
      db,
      clienteId,
      { estimatedCost, purpose: DESCRIBE_PURPOSE, provider: vision.name, model },
      actor,
    );

    const started = Date.now();
    let result;
    try {
      result = await vision.describe({ mediaRef: media.clave_almacenamiento, mime: media.mime, maxOutputTokens: MAX_OUTPUT_TOKENS });
    } catch (error) {
      await closeAfterProviderError(deps, clienteId, authorization, model, error, actor, log);
      log.error(
        { ...meta, attempt: attemptNumber, durationMs: Date.now() - started, outcome: 'error', errorName: errorName(error) },
        'vision call failed',
      );
      throw error;
    }

    const cost = await computeCost(db, {
      provider: vision.name,
      model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    const parsed = outputSchema.safeParse({ description: result.description, tags: result.tags });
    const outcome = parsed.success ? 'ok' : 'schema_invalido';
    await settle(
      db,
      authorization,
      { actualCost: cost, inputUnits: result.inputTokens, outputUnits: result.outputTokens, outcome },
      actor,
    );
    log.info(
      {
        ...meta,
        attempt: attemptNumber,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cost: microToUsd(cost),
        durationMs: Date.now() - started,
        outcome,
      },
      'vision call settled',
    );
    return { cost, inputTokens: result.inputTokens, outputTokens: result.outputTokens, output: parsed.success ? parsed.data : null };
  };

  let attempt = await attemptOnce(1);
  if (!attempt.output) attempt = await attemptOnce(2); // a new paid call with its own authorization
  if (!attempt.output) {
    await deps.alerts.alert({ code: 'vision_schema_invalid', clienteId, purpose: DESCRIBE_PURPOSE, provider: vision.name, model, attempts: 2 });
    throw new SchemaValidationError(DESCRIBE_PURPOSE, 2);
  }

  const descripcion = attempt.output.description;
  const sugeridas = normalizeSuggestedTags(attempt.output.tags);
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ descripcion: string | null; descrito_en: Date | null }>(
      'SELECT descripcion, descrito_en FROM media WHERE id = $1 AND cliente_id = $2 AND eliminado_en IS NULL FOR UPDATE',
      [mediaId, clienteId],
    );
    const before = rows[0];
    if (!before) throw new MediaNotFoundError(); // deleted while the model was working
    // Only the three description columns: the human tags (`etiquetas`) are never touched.
    await tx.query(
      'UPDATE media SET descripcion = $3, etiquetas_sugeridas = $4, descrito_en = now() WHERE id = $1 AND cliente_id = $2',
      [mediaId, clienteId, descripcion, sugeridas],
    );
    await recordAudit(tx, {
      actor,
      accion: 'describir',
      tabla: 'media',
      filaId: mediaId,
      clienteId,
      // Lengths and counts only: the description itself is client-related content.
      antes: before.descrito_en ? { descrito_en: before.descrito_en.toISOString(), descripcion_longitud: before.descripcion?.length ?? 0 } : null,
      despues: { modelo: model, descripcion_longitud: descripcion.length, etiquetas_sugeridas: sugeridas.length },
    });
    return (await getMedia(tx, clienteId, mediaId))!;
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * The vision provider failed: charge what it reports as used (outcome "error"), or give the
 * reservation back when it reports nothing. A failure here is logged and never hides the original error.
 */
async function closeAfterProviderError(
  deps: DescribeMediaDeps,
  clienteId: ClienteId,
  authorization: SpendAuthorization,
  model: string,
  error: unknown,
  actor: AuditActor,
  log: Logger,
): Promise<void> {
  try {
    if (error instanceof VisionProviderError && error.usage) {
      const cost = await computeCost(deps.db, {
        provider: deps.vision.name,
        model,
        inputTokens: error.usage.inputTokens,
        outputTokens: error.usage.outputTokens,
      });
      await settle(
        deps.db,
        authorization,
        { actualCost: cost, inputUnits: error.usage.inputTokens, outputUnits: error.usage.outputTokens, outcome: 'error' },
        actor,
      );
    } else {
      await release(deps.db, authorization, actor);
    }
  } catch (closeError) {
    log.error(
      { clienteId, purpose: DESCRIBE_PURPOSE, authorizationId: authorization.id, errorName: errorName(closeError) },
      'could not close the spend authorization after a vision provider error',
    );
  }
}
