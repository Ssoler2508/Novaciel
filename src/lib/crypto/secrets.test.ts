import { describe, expect, it } from 'vitest';
import { SecretsConfig } from '../../config/index.js';
import { decryptSecret, encryptSecret, SecretsError, type EncryptedSecret } from './secrets.js';

const key = (fill: number) => Buffer.alloc(32, fill);
const ring = (active: number) =>
  new SecretsConfig(
    new Map([
      [1, key(1)],
      [2, key(2)],
    ]),
    active,
  );

const plaintext = 'fake-access-token-for-tests-only';
const context = 'conexiones_redes:11111111-1111-1111-1111-111111111111:instagram';

function flip(buf: Buffer): Buffer {
  const copy = Buffer.from(buf);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
}

describe('secrets encryption', () => {
  it('round-trips with the default (test) keyring', () => {
    const enc = encryptSecret(plaintext, context);
    expect(enc.keyVersion).toBe(1);
    expect(enc.iv).toHaveLength(12);
    expect(enc.authTag).toHaveLength(16);
    expect(enc.ciphertext.toString('utf8')).not.toContain(plaintext);
    expect(decryptSecret(enc, context)).toBe(plaintext);
  });

  it('handles non-ASCII and empty plaintext', () => {
    for (const text of ['contraseña ñandú ✓', '']) {
      expect(decryptSecret(encryptSecret(text, context), context)).toBe(text);
    }
  });

  it('gives different ciphertexts and IVs for the same plaintext', () => {
    const a = encryptSecret(plaintext, context);
    const b = encryptSecret(plaintext, context);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  const failures: [string, (e: EncryptedSecret) => [EncryptedSecret, string]][] = [
    ['tampered ciphertext', (e) => [{ ...e, ciphertext: flip(e.ciphertext) }, context]],
    ['tampered tag', (e) => [{ ...e, authTag: flip(e.authTag) }, context]],
    ['tampered iv', (e) => [{ ...e, iv: flip(e.iv) }, context]],
    ['wrong context', (e) => [e, `${context}x`]],
  ];
  it.each(failures)('fails with %s', (_name, build) => {
    const [enc, ctx] = build(encryptSecret(plaintext, context));
    expect(() => decryptSecret(enc, ctx)).toThrow(SecretsError);
    try {
      decryptSecret(enc, ctx);
    } catch (err) {
      expect((err as SecretsError).code).toBe('decryption_failed');
      expect((err as Error).message).not.toContain(plaintext);
      expect((err as Error).message).not.toContain(context);
    }
  });

  it('keeps decrypting old values after rotation', () => {
    const old = encryptSecret(plaintext, context, ring(1));
    expect(old.keyVersion).toBe(1);
    expect(decryptSecret(old, context, ring(2))).toBe(plaintext);
    expect(encryptSecret(plaintext, context, ring(2)).keyVersion).toBe(2);
  });

  it('does not decrypt with a different key version', () => {
    const enc = { ...encryptSecret(plaintext, context, ring(1)), keyVersion: 2 };
    expect(() => decryptSecret(enc, context, ring(2))).toThrow(SecretsError);
  });

  it('throws a typed error for an unknown key version', () => {
    const enc = { ...encryptSecret(plaintext, context), keyVersion: 9 };
    const call = () => decryptSecret(enc, context);
    expect(call).toThrow(SecretsError);
    expect(call).toThrow(/unknown key version/);
  });
});
