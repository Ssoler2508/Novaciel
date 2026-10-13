import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { config } from '../../config/index.js';
import {
  assertPasswordPolicy,
  hashPassword,
  needsRehash,
  PasswordPolicyError,
  verifyPassword,
} from './passwords.js';

const PASSWORD = 'correct horse battery';

describe('passwords', () => {
  it('hashes into a self-describing string and verifies it', async () => {
    const stored = await hashPassword(PASSWORD);
    const [algo, N, r, p, salt] = stored.split('$');
    expect([algo, Number(N), r, p]).toEqual(['scrypt', 2 ** config.PASSWORD_SCRYPT_LOG_N, '8', '1']);
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16);
    expect(stored).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
  });

  it('gives different hashes for the same password', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('rejects a wrong password', async () => {
    expect(await verifyPassword('another password!!', await hashPassword(PASSWORD))).toBe(false);
  });

  it.each(['', 'nonsense', 'scrypt$1$1$1$a$b', 'bcrypt$1$2$3$YQ==$YQ==', 'scrypt$32768$8$1$$', 'scrypt$3$8$1$YQ==$YQ=='])(
    'returns false for the malformed stored value %j',
    async (stored) => {
      expect(await verifyPassword(PASSWORD, stored)).toBe(false);
    },
  );

  it('refuses absurd cost parameters without computing them', async () => {
    expect(await verifyPassword(PASSWORD, `scrypt$${2 ** 30}$8$1$YQ==$YQ==`)).toBe(false);
  });

  it('enforces the policy limits (12 to 128 characters)', () => {
    for (const ok of ['a'.repeat(12), 'a'.repeat(128)]) expect(() => assertPasswordPolicy(ok)).not.toThrow();
    for (const bad of ['a'.repeat(11), 'a'.repeat(129), '']) {
      expect(() => assertPasswordPolicy(bad)).toThrow(PasswordPolicyError);
    }
    try {
      assertPasswordPolicy('short-pw');
    } catch (err) {
      expect((err as Error).message).not.toContain('short-pw');
    }
  });

  it('needsRehash is true only for a lower cost than the configured one', async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
    const lowN = 2 ** (config.PASSWORD_SCRYPT_LOG_N - 1);
    const key = scryptSync(PASSWORD, Buffer.alloc(16, 1), 32, { N: lowN, r: 8, p: 1 });
    const low = `scrypt$${lowN}$8$1$${Buffer.alloc(16, 1).toString('base64')}$${key.toString('base64')}`;
    expect(await verifyPassword(PASSWORD, low)).toBe(true);
    expect(needsRehash(low)).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
});
