import { describe, expect, it } from 'vitest';
import { FakeLLMProvider } from './fakeLLMProvider.js';
import { modelForPurpose, PURPOSE_TIER, PURPOSES, tierForPurpose, type ModelTier, type Purpose } from './modelTiers.js';

describe('purpose to tier map', () => {
  it('classifies every purpose, and only the purposes', () => {
    expect(Object.keys(PURPOSE_TIER).sort()).toEqual([...PURPOSES].sort());
    for (const purpose of PURPOSES) expect(['heavy', 'light']).toContain(PURPOSE_TIER[purpose]);
  });

  it('puts planning, briefs and the heavy smoke test on the heavy tier, and media and the light smoke test on the light one', () => {
    expect(PURPOSE_TIER).toEqual({
      plan_semanal: 'heavy',
      brief_creativo: 'heavy',
      describe_media: 'light',
      smoke_test_pesado: 'heavy',
      smoke_test_ligero: 'light',
    });
  });

  it('does not compile with an unclassified purpose (compile-time check, enforced by npm run typecheck)', () => {
    // @ts-expect-error a purpose outside PURPOSES is not accepted
    const unknown: Purpose = 'purpose_nuevo_sin_clasificar';
    // @ts-expect-error a map that misses a purpose is not a Record<Purpose, ModelTier>
    const incomplete: Record<Purpose, ModelTier> = { plan_semanal: 'heavy' };
    expect([unknown, incomplete]).toBeDefined();
    expect(() => tierForPurpose('purpose_nuevo_sin_clasificar' as Purpose)).toThrow(/no model tier/);
  });

  it('resolves the model id of the tier from the provider', () => {
    const provider = new FakeLLMProvider({ models: { heavy: 'modelo-pesado-test', light: 'modelo-ligero-test' } });
    expect(modelForPurpose(provider, 'plan_semanal')).toBe('modelo-pesado-test');
    expect(modelForPurpose(provider, 'describe_media')).toBe('modelo-ligero-test');
  });
});
