import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { config } from '../../config/index.js';

// Stored format: scrypt$N$r$p$<salt base64>$<hash base64>. Parameters live in the string, so the
// cost can change later and old hashes keep verifying (see needsRehash).

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
// Upper bounds for parameters read from a stored string, so a corrupt value cannot exhaust memory.
const MAX_LOG_N = 20;
const MAX_R = 16;
const MAX_P = 4;

export class PasswordPolicyError extends Error {
  constructor() {
    // Fixed message: never includes the password.
    super(`Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`);
    this.name = 'PasswordPolicyError';
  }
}

export function assertPasswordPolicy(plain: string): void {
  if (plain.length < PASSWORD_MIN_LENGTH || plain.length > PASSWORD_MAX_LENGTH) throw new PasswordPolicyError();
}

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function deriveKey(plain: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem: scrypt needs about 128 * N * r bytes; leave headroom over that.
    scrypt(plain, salt, KEY_BYTES, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hashes with the cost from config (PASSWORD_SCRYPT_LOG_N). Does not check the policy. */
export async function hashPassword(plain: string): Promise<string> {
  const params = { N: 2 ** config.PASSWORD_SCRYPT_LOG_N, r: BLOCK_SIZE, p: PARALLELISM };
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(plain, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseStored(stored: string): (ScryptParams & { salt: Buffer; key: Buffer }) | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const isPowerOfTwo = Number.isInteger(N) && N >= 2 && N <= 2 ** MAX_LOG_N && (N & (N - 1)) === 0;
  if (!isPowerOfTwo) return null;
  if (!Number.isInteger(r) || r < 1 || r > MAX_R || !Number.isInteger(p) || p < 1 || p > MAX_P) return null;
  const salt = Buffer.from(parts[4]!, 'base64');
  const key = Buffer.from(parts[5]!, 'base64');
  if (salt.length === 0 || key.length === 0) return null;
  return { N, r, p, salt, key };
}

/** False for a wrong password and for a malformed stored value; never throws on bad input. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  const actual = await deriveKey(plain, parsed.salt, parsed);
  return actual.length === parsed.key.length && timingSafeEqual(actual, parsed.key);
}

/** True when the stored hash was made with a lower cost than the configured one (or is unreadable). */
export function needsRehash(stored: string): boolean {
  const parsed = parseStored(stored);
  return !parsed || parsed.N < 2 ** config.PASSWORD_SCRYPT_LOG_N;
}
