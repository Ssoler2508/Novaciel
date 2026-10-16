import type { LlmConfig } from '../../config/index.js';
import { createLLMProvider } from '../../lib/ai/index.js';
import type { LLMProvider } from '../../lib/ai/types.js';
import { DeterministicPlannerFake } from './deterministicPlannerFake.js';
import type { PlanificadorDeps } from './planificadorService.js';

/** The provider the planner uses, plus the optional side channel only the fake needs. */
export interface PlannerRuntime {
  provider: LLMProvider;
  withContext?: PlanificadorDeps['withContext'];
}

/**
 * LLM_PROVIDER=fake gives the deterministic planner fake (development and tests: a complete flow
 * with no key); LLM_PROVIDER=claude gives the real provider. The fake is refused in production.
 */
export function createPlannerProvider(cfg: LlmConfig, nodeEnv: string): PlannerRuntime {
  if (cfg.provider === 'fake') {
    if (nodeEnv === 'production') throw new Error('The deterministic planner fake is for development and tests only');
    const fake = new DeterministicPlannerFake({ defaultModel: cfg.model });
    return { provider: fake, withContext: (context, run) => fake.withContext(context, run) };
  }
  return { provider: createLLMProvider(cfg) };
}
