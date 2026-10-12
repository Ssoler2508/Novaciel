import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config, type SecretsConfig } from '../../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Buffers map straight to bytea columns. */
export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export type SecretsErrorCode = 'unknown_key_version' | 'decryption_failed';

/** Messages are fixed strings: they never include plaintext, keys, context or ciphertext. */
export class SecretsError extends Error {
  constructor(readonly code: SecretsErrorCode) {
    super(
      code === 'unknown_key_version'
        ? 'Secret was encrypted with an unknown key version'
        : 'Secret could not be decrypted',
    );
    this.name = 'SecretsError';
  }
}

/**
 * Encrypts with the active key. `context` is bound as additional authenticated data
 * (e.g. `conexiones_redes:<cliente_id>:<red>`), so a value copied elsewhere will not decrypt.
 */
export function encryptSecret(
  plaintext: string,
  context: string,
  keyring: SecretsConfig = config.secrets,
): EncryptedSecret {
  const keyVersion = keyring.activeVersion;
  const key = keyring.getKey(keyVersion);
  if (!key) throw new SecretsError('unknown_key_version');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion };
}

/** Decrypts with the key of `encrypted.keyVersion`, so old values keep working after rotation. */
export function decryptSecret(
  encrypted: EncryptedSecret,
  context: string,
  keyring: SecretsConfig = config.secrets,
): string {
  const key = keyring.getKey(encrypted.keyVersion);
  if (!key) throw new SecretsError('unknown_key_version');
  try {
    const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(encrypted.authTag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Node's own error text is discarded on purpose.
    throw new SecretsError('decryption_failed');
  }
}
