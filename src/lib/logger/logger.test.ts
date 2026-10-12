import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';

const fields = [
  'password',
  'contrasena',
  'token',
  'session',
  'cookie',
  'secret',
  'ciphertext',
  'password_hash',
  'authorization',
];

function capture(obj: object): Record<string, any> {
  const lines: string[] = [];
  createLogger('info', { write: (l: string) => void lines.push(l) }).info(obj, 'event');
  return JSON.parse(lines.join(''));
}

describe('logger redaction', () => {
  it.each(fields)('redacts %s at top level, one level and two levels deep', (field) => {
    const value = `value-of-${field}`;
    const out = capture({ [field]: value, a: { [field]: value }, a2: { b: { [field]: value } } });
    expect(out[field]).toBe('[REDACTED]');
    expect(out.a[field]).toBe('[REDACTED]');
    expect(out.a2.b[field]).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain(value);
  });

  it('keeps non-sensitive fields', () => {
    expect(capture({ email: 'a@example.com' }).email).toBe('a@example.com');
  });
});
