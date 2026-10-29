import Anthropic from '@anthropic-ai/sdk';
import type { TierModels, ModelTier } from './modelTiers.js';
import { LLMProviderError, type LLMProvider, type LLMRequest, type LLMResponse } from './types.js';

// Claude implementation of LLMProvider. Rules it keeps:
// - The API key is ours (NOVACIEL_ANTHROPIC_API_KEY, passed in by the caller). The SDK would
//   otherwise read ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_LOG
//   from the environment; every one of them is set explicitly here so none can leak in (Claude Code
//   itself uses ANTHROPIC_API_KEY for its own login, and a stray base URL would receive our key).
// - Errors never carry request or response content, nor the key: only a fixed text and a status.

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * The SDK retries connection errors, timeouts, 408/409/429 and 5xx (it cannot be limited to 5xx
 * alone). One retry keeps that small; a retried timeout may in rare cases be billed twice by the
 * provider while one usage is settled. Schema retries live in generateStructured, not here.
 */
export const SDK_MAX_RETRIES = 1;

export type ClaudeErrorKind = 'rate_limited' | 'auth' | 'bad_request' | 'server' | 'timeout';

export class ClaudeProviderError extends LLMProviderError {
  constructor(
    readonly kind: ClaudeErrorKind,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(
      `Claude request failed: ${kind}${status ? ` (status ${status})` : ''}${requestId ? ` [request ${requestId}]` : ''}`,
    );
    this.name = 'ClaudeProviderError';
  }
}

export interface ClaudeProviderOptions {
  apiKey: string;
  models: TierModels;
  timeoutMs: number;
  maxRetries?: number;
  /** For tests only; production uses the fixed Anthropic URL. */
  baseURL?: string;
  /** For tests only: a fake HTTP layer, so no network is used. */
  fetch?: typeof fetch;
}

export class ClaudeProvider implements LLMProvider {
  readonly name = 'claude';
  readonly #models: TierModels;
  readonly #client: Anthropic;

  constructor(options: ClaudeProviderOptions) {
    this.#models = options.models;
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      authToken: null,
      baseURL: options.baseURL ?? ANTHROPIC_BASE_URL,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries ?? SDK_MAX_RETRIES,
      logLevel: 'off',
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  modelFor(tier: ModelTier): string {
    return this.#models[tier];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create({
        model: this.modelFor(request.tier),
        max_tokens: request.maxOutputTokens,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (error) {
      throw mapError(error);
    }
    const usage = message.usage;
    return {
      text: message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
      // Cached tokens are billed too; we do not use caching, but summing never under-counts.
      inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      model: message.model,
      stopReason: message.stop_reason ?? 'unknown',
    };
  }
}

function mapError(error: unknown): ClaudeProviderError {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ClaudeProviderError('timeout');
  if (error instanceof Anthropic.APIConnectionError) return new ClaudeProviderError('server');
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const requestId = error.requestID ?? undefined;
    if (status === 429) return new ClaudeProviderError('rate_limited', status, requestId);
    if (status === 401 || status === 403) return new ClaudeProviderError('auth', status, requestId);
    if (typeof status === 'number' && status >= 500) return new ClaudeProviderError('server', status, requestId);
    if (typeof status === 'number' && status >= 400) return new ClaudeProviderError('bad_request', status, requestId);
    return new ClaudeProviderError('server', status, requestId);
  }
  // Anything unrecognised: do not forward its message, it could contain request content.
  return new ClaudeProviderError('server');
}
