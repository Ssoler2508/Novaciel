import { AsyncLocalStorage } from 'node:async_hooks';
import type { LlmConfig } from '../../config/index.js';
import { createLLMProvider } from '../../lib/ai/index.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../lib/ai/types.js';
import { buildDeterministicBrief } from '../directorCreativo/deterministicBriefFake.js';
import { BRIEF_PURPOSE } from '../directorCreativo/directorService.js';
import type { BriefContext } from '../directorCreativo/types.js';
import { buildDeterministicPlan } from '../planificador/deterministicPlannerFake.js';
import { PLAN_PURPOSE } from '../planificador/planificadorService.js';
import { buildPlanSchema } from '../planificador/schema.js';
import type { PlannerContext } from '../planificador/types.js';

// ONE provider for DEVELOPMENT and TESTS that serves both the weekly planner and the creative
// director, so the whole flow works locally without any API key (LLM_PROVIDER=fake).
//
// SIDE CHANNEL: LLMRequest carries no purpose and the fake must never parse the prompt (it holds
// client text, rule 9), so each service wraps its model call in withPlannerContext / withBriefContext,
// which put the STRUCTURED context, tagged with its purpose, in an AsyncLocalStorage. generate()
// reads that and dispatches by purpose. Concurrent jobs of both kinds never mix: each one runs in
// its own async context.

type Channel =
  | { purpose: typeof PLAN_PURPOSE; context: PlannerContext }
  | { purpose: typeof BRIEF_PURPOSE; context: BriefContext };

const channel = new AsyncLocalStorage<Channel>();

export class DeterministicDevProvider implements LLMProvider {
  readonly name = 'fake';
  readonly defaultModel: string;

  constructor(options: { defaultModel?: string } = {}) {
    this.defaultModel = options.defaultModel ?? 'fake-model';
  }

  /** Runs `run` with the planner context available to generate() (purpose plan_semanal). */
  withPlannerContext<T>(context: PlannerContext, run: () => Promise<T>): Promise<T> {
    return channel.run({ purpose: PLAN_PURPOSE, context }, run);
  }

  /** Runs `run` with the brief context available to generate() (purpose brief_creativo). */
  withBriefContext<T>(context: BriefContext, run: () => Promise<T>): Promise<T> {
    return channel.run({ purpose: BRIEF_PURPOSE, context }, run);
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const store = channel.getStore();
    if (!store) {
      throw new Error('DeterministicDevProvider needs a context (run it through generarPlanSemanal or generarBrief with its withContext hook)');
    }
    let output: unknown;
    if (store.purpose === PLAN_PURPOSE) {
      const plan = buildDeterministicPlan(store.context);
      // A bug in this fake must never reach the database: check its own work with the real schema.
      const check = buildPlanSchema(store.context).safeParse(plan);
      if (!check.success) {
        throw new Error(`DeterministicDevProvider built an invalid plan: ${check.error.issues.map((i) => i.message).join(', ')}`);
      }
      output = plan;
    } else {
      output = buildDeterministicBrief(store.context); // validates itself
    }
    const text = JSON.stringify(output);
    return {
      text,
      // Sizes only: the prompt text itself is never read.
      inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(request)) / 4),
      outputTokens: Math.ceil(text.length / 4),
      model: request.model ?? this.defaultModel,
      stopReason: 'end_turn',
    };
  }
}

/** The provider the app uses, plus the side-channel hooks only the development fake needs. */
export interface LlmRuntime {
  provider: LLMProvider;
  withPlannerContext?: <T>(context: PlannerContext, run: () => Promise<T>) => Promise<T>;
  withBriefContext?: <T>(context: BriefContext, run: () => Promise<T>) => Promise<T>;
}

/**
 * LLM_PROVIDER=fake gives the development provider (a complete flow with no key) with both hooks;
 * LLM_PROVIDER=claude gives the real provider and no hooks. The fake is refused in production.
 */
export function createLlmRuntime(cfg: LlmConfig, nodeEnv: string): LlmRuntime {
  if (cfg.provider === 'fake') {
    if (nodeEnv === 'production') throw new Error('The deterministic development provider is for development and tests only');
    const fake = new DeterministicDevProvider({ defaultModel: cfg.model });
    return {
      provider: fake,
      withPlannerContext: (context, run) => fake.withPlannerContext(context, run),
      withBriefContext: (context, run) => fake.withBriefContext(context, run),
    };
  }
  return { provider: createLLMProvider(cfg) };
}
