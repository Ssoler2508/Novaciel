import type { LlmConfig } from '../../config/index.js';
import { ClaudeProvider } from './claudeProvider.js';
import { FakeLLMProvider } from './fakeLLMProvider.js';
import type { LLMProvider } from './types.js';

export type { LLMMessage, LLMProvider, LLMRequest, LLMResponse } from './types.js';
export { LLMProviderError } from './types.js';
export { ClaudeProvider, ClaudeProviderError } from './claudeProvider.js';
export type { ClaudeErrorKind } from './claudeProvider.js';
export { FakeLLMProvider } from './fakeLLMProvider.js';
export type { ScriptedReply } from './fakeLLMProvider.js';
export { modelForPurpose, PURPOSES, PURPOSE_TIER, tierForPurpose } from './modelTiers.js';
export type { ModelTier, Purpose, TierModels, TierModelSource } from './modelTiers.js';
export { FakeAlertSink, LogAlertSink } from './alerts.js';
export type { Alert, AlertSink } from './alerts.js';

/** Builds the provider chosen by configuration. */
export function createLLMProvider(cfg: LlmConfig): LLMProvider {
  if (cfg.provider === 'fake') return new FakeLLMProvider({ models: cfg.models });
  if (!cfg.apiKey) throw new Error('NOVACIEL_ANTHROPIC_API_KEY is required for the claude provider');
  return new ClaudeProvider({ apiKey: cfg.apiKey.reveal(), models: cfg.models, timeoutMs: cfg.timeoutMs });
}
