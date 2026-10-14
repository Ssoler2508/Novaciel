import type { Db } from '../../db/types.js';
import type { MicroUsd } from '../presupuesto/money.js';
import { getPriceAt } from './preciosRepository.js';

// Cost in micro-USD = ceil((inputTokens * priceIn + outputTokens * priceOut) / 1_000_000), with the
// prices in micro-USD per million tokens. All bigint, one rounding step, always upwards.

const TOKENS_PER_PRICE_UNIT = 1_000_000n;

function assertTokens(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

async function cost(db: Db, provider: string, model: string, inputTokens: bigint, outputTokens: bigint, at?: Date): Promise<MicroUsd> {
  const price = await getPriceAt(db, provider, model, at);
  return ceilDiv(inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion, TOKENS_PER_PRICE_UNIT);
}

export interface EstimateCostRequest {
  provider: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  at?: Date;
}

/** Worst-case cost of a call, rounded up. Throws PriceNotFoundError for an unpriced model. */
export async function estimateCost(db: Db, request: EstimateCostRequest): Promise<MicroUsd> {
  return cost(
    db,
    request.provider,
    request.model,
    assertTokens(request.maxInputTokens, 'maxInputTokens'),
    assertTokens(request.maxOutputTokens, 'maxOutputTokens'),
    request.at,
  );
}

export interface ComputeCostRequest {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  at?: Date;
}

/** Real cost from actual usage, rounded up (so the ledger never under-records). */
export async function computeCost(db: Db, request: ComputeCostRequest): Promise<MicroUsd> {
  return cost(
    db,
    request.provider,
    request.model,
    assertTokens(request.inputTokens, 'inputTokens'),
    assertTokens(request.outputTokens, 'outputTokens'),
    request.at,
  );
}
