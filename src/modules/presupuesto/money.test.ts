import { describe, expect, it } from 'vitest';
import { assertMicro, microToUsd, usdToMicro } from './money.js';

describe('money', () => {
  it('round-trips exact decimal strings', () => {
    for (const value of ['0.000000', '0.000001', '0.300000', '1.000000', '12345.678901']) {
      expect(microToUsd(usdToMicro(value))).toBe(value);
    }
  });

  it('parses without float drift', () => {
    expect(usdToMicro('0.1') + usdToMicro('0.2')).toBe(usdToMicro('0.3'));
    expect(usdToMicro('1')).toBe(1_000_000n);
    expect(usdToMicro('1.5')).toBe(1_500_000n);
  });

  it('rejects invalid input', () => {
    for (const bad of ['', 'NaN', '-1', '1e3', '1.1234567', '1,5', 'abc', '.5']) {
      expect(() => usdToMicro(bad)).toThrow();
    }
  });

  it('rejects negative micro amounts', () => {
    expect(() => microToUsd(-1n)).toThrow();
    expect(() => assertMicro(-1n, 'x')).toThrow();
    expect(() => assertMicro(1.5, 'x')).toThrow();
    expect(() => assertMicro(5n, 'x')).not.toThrow();
  });
});
