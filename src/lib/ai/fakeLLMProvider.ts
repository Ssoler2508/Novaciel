import type { LLMProvider, LLMRequest, LLMResponse } from './types.js';

export type ScriptedReply =
  | string
  | { text: string; inputTokens?: number; outputTokens?: number; stopReason?: string }
  | { error: Error };

export interface FakeLLMOptions {
  name?: string;
  defaultModel?: string;
  /** Token usage reported for replies that do not set their own. */
  inputTokens?: number;
  outputTokens?: number;
}

/** Scripted provider for tests: replies come from a queue, calls are recorded, nothing is paid. */
export class FakeLLMProvider implements LLMProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly calls: LLMRequest[] = [];
  readonly #queue: ScriptedReply[] = [];
  #inputTokens: number;
  #outputTokens: number;

  constructor(options: FakeLLMOptions = {}) {
    this.name = options.name ?? 'fake';
    this.defaultModel = options.defaultModel ?? 'fake-model';
    this.#inputTokens = options.inputTokens ?? 100;
    this.#outputTokens = options.outputTokens ?? 50;
  }

  /** Queues replies, answered in order. */
  enqueue(...replies: ScriptedReply[]): this {
    this.#queue.push(...replies);
    return this;
  }

  /** Changes the usage reported by the replies that do not set their own. */
  setUsage(usage: { inputTokens: number; outputTokens: number }): this {
    this.#inputTokens = usage.inputTokens;
    this.#outputTokens = usage.outputTokens;
    return this;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(structuredClone(request));
    const reply = this.#queue.shift();
    if (reply === undefined) throw new Error('FakeLLMProvider has no scripted reply left');
    if (typeof reply === 'object' && 'error' in reply) throw reply.error;
    const scripted = typeof reply === 'string' ? { text: reply } : reply;
    return {
      text: scripted.text,
      inputTokens: ('inputTokens' in scripted ? scripted.inputTokens : undefined) ?? this.#inputTokens,
      outputTokens: ('outputTokens' in scripted ? scripted.outputTokens : undefined) ?? this.#outputTokens,
      model: request.model ?? this.defaultModel,
      stopReason: ('stopReason' in scripted ? scripted.stopReason : undefined) ?? 'end_turn',
    };
  }
}
