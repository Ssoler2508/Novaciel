import { randomUUID } from 'node:crypto';

/** Short random suffix so values (names, emails, codes) never collide between tests. */
export function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}
