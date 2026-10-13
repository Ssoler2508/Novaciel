import type { LlmConfig } from '../../config/index.js';
import { FakeLLMProvider } from './fakeLLMProvider.js';
import type { LLMProvider } from './types.js';

export type { LLMMessage, LLMProvider, LLMRequest, LLMResponse } from './types.js';
export { LLMProviderError } from './types.js';
export { FakeLLMProvider } from './fakeLLMProvider.js';
export type { ScriptedReply } from './fakeLLMProvider.js';
export { FakeAlertSink, LogAlertSink } from './alerts.js';
export type { Alert, AlertSink } from './alerts.js';

/** Builds the provider chosen by configuration. The Claude provider arrives in a later checkpoint. */
export function createLLMProvider(cfg: LlmConfig): LLMProvider {
  if (cfg.provider === 'fake') return new FakeLLMProvider({ defaultModel: cfg.model });
  throw new Error('LLM_PROVIDER "claude" is not available yet');
}
