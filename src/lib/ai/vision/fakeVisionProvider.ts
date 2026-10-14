import type { VisionProvider, VisionRequest, VisionResult } from './types.js';

export type ScriptedVision =
  | { description: string; tags: string[]; inputTokens?: number; outputTokens?: number; model?: string }
  | { error: Error };

export interface FakeVisionOptions {
  name?: string;
  defaultModel?: string;
  /** Usage reported by the results that do not set their own. */
  inputTokens?: number;
  outputTokens?: number;
}

/** Scripted provider for tests: results come from a queue, calls are recorded, nothing is paid. */
export class FakeVisionProvider implements VisionProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly calls: VisionRequest[] = [];
  readonly #queue: ScriptedVision[] = [];
  #inputTokens: number;
  #outputTokens: number;

  constructor(options: FakeVisionOptions = {}) {
    this.name = options.name ?? 'fake_vision';
    this.defaultModel = options.defaultModel ?? 'fake-vision-model';
    this.#inputTokens = options.inputTokens ?? 1000;
    this.#outputTokens = options.outputTokens ?? 100;
  }

  /** Queues results, answered in order. */
  enqueue(...results: ScriptedVision[]): this {
    this.#queue.push(...results);
    return this;
  }

  async describe(request: VisionRequest): Promise<VisionResult> {
    this.calls.push({ ...request });
    const next = this.#queue.shift();
    if (next === undefined) throw new Error('FakeVisionProvider has no scripted result left');
    if ('error' in next) throw next.error;
    return {
      description: next.description,
      tags: next.tags,
      inputTokens: next.inputTokens ?? this.#inputTokens,
      outputTokens: next.outputTokens ?? this.#outputTokens,
      model: next.model ?? this.defaultModel,
    };
  }
}
