// Provider-neutral language model interface. Implementations: FakeLLMProvider (tests) and, in a
// later checkpoint, ClaudeProvider. Prompts and outputs may contain client data: nothing in this
// layer logs their content.

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  maxOutputTokens: number;
  /** Overrides the provider's configured model. */
  model?: string;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The model that actually answered. */
  model: string;
  stopReason: string;
}

export interface LLMProvider {
  /** Provider name as used in the price table and the spend ledger (for example "fake"). */
  readonly name: string;
  /** The model used when a request does not name one. */
  readonly defaultModel: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
}

/**
 * A failed provider call. `usage` is set only when the provider reported consumption for the failed
 * call, so it can still be charged. The message must never contain request or response content.
 */
export class LLMProviderError extends Error {
  constructor(
    message: string,
    readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}
