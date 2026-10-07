const SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Validates a logical storage key ("/" separated) with an allowlist and returns its segments.
 * Throws on anything that could escape the base folder or is not a valid Windows file name.
 */
export function validateKey(key: string): string[] {
  if (typeof key !== 'string' || key.length === 0) throw new Error('Invalid storage key: empty');
  const segments = key.split('/');
  for (const segment of segments) {
    if (
      !SEGMENT.test(segment) ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      WINDOWS_RESERVED.test(segment.split('.')[0] ?? '')
    ) {
      throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    }
  }
  return segments;
}
