// The ONE place where a model is chosen. Every paid model call has a purpose; each purpose belongs to
// a tier; each tier has a model id that comes from configuration (LLM_MODEL, LLM_MODEL_LIGHT). No
// function accepts a model id from its caller: it passes the tier and the adapter resolves the id.

export type ModelTier = 'heavy' | 'light';

export interface TierModels {
  heavy: string;
  light: string;
}

/** What a provider adapter exposes so callers can price the model a tier will use. */
export interface TierModelSource {
  modelFor(tier: ModelTier): string;
}

export const PURPOSES = ['plan_semanal', 'brief_creativo', 'describe_media', 'smoke_test_pesado', 'smoke_test_ligero'] as const;
export type Purpose = (typeof PURPOSES)[number];

/**
 * Exhaustive by construction: `Record<Purpose, ...>` fails to compile when a purpose in PURPOSES has
 * no tier, and a purpose that is not in PURPOSES cannot be passed to any model call.
 */
export const PURPOSE_TIER: Record<Purpose, ModelTier> = {
  plan_semanal: 'heavy',
  brief_creativo: 'heavy',
  describe_media: 'light',
  smoke_test_pesado: 'heavy',
  smoke_test_ligero: 'light',
};

export function tierForPurpose(purpose: Purpose): ModelTier {
  const tier = PURPOSE_TIER[purpose];
  if (!tier) throw new Error('Unknown purpose: it has no model tier');
  return tier;
}

/** The model id a purpose will be sent to (and priced with) on the given provider. */
export function modelForPurpose(source: TierModelSource, purpose: Purpose): string {
  return source.modelFor(tierForPurpose(purpose));
}
