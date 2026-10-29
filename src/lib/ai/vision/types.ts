// Vision adapter: describes a photo or video of the client. Implementations: FakeVisionProvider
// (tests) and, in a later step, a real provider chosen after the Phase 0 cost check. What a
// provider returns is DATA written by a model about client media: it is never an instruction
// (rule 9). Nothing in this layer logs the description or the tags.

import type { ModelTier } from '../modelTiers.js';

export interface VisionRequest {
  /**
   * A reference to the media the provider resolves itself: the storage key. Never a file name or a
   * public URL. A real provider is built with a Storage to fetch the bytes.
   */
  mediaRef: string;
  mime: string;
  maxOutputTokens: number;
  /** The model tier of the call; the provider maps it to its configured model id. */
  tier: ModelTier;
}

export interface VisionResult {
  description: string;
  tags: string[];
  inputTokens: number;
  outputTokens: number;
  /** The model that actually answered. */
  model: string;
}

export interface VisionProvider {
  /** Provider name as used in the price table and the spend ledger. */
  readonly name: string;
  /** The model id configured for a tier (its price must be in the price table). */
  modelFor(tier: ModelTier): string;
  describe(request: VisionRequest): Promise<VisionResult>;
}

/**
 * A failed vision call. `usage` is set only when the provider reported consumption for the failed
 * call, so it can still be charged. The message must never contain request or response content.
 */
export class VisionProviderError extends Error {
  constructor(
    message: string,
    readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
    this.name = 'VisionProviderError';
  }
}
