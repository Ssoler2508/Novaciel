import type { MediaProbe, ProbeResult } from './types.js';

export type ScriptedProbe = ProbeResult | { error: Error };

/** Scripted probe for tests: results come from a queue, calls are recorded. No ffprobe needed. */
export class FakeMediaProbe implements MediaProbe {
  readonly calls: string[] = [];
  readonly #queue: ScriptedProbe[] = [];

  /** Queues answers, used in order. */
  enqueue(...answers: ScriptedProbe[]): this {
    this.#queue.push(...answers);
    return this;
  }

  async probe(filePath: string): Promise<ProbeResult> {
    this.calls.push(filePath);
    const answer = this.#queue.shift();
    if (answer === undefined) throw new Error('FakeMediaProbe has no scripted answer left');
    if ('error' in answer) throw answer.error;
    return answer;
  }
}
