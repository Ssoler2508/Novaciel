import type { CookieSerializeOptions } from '@fastify/cookie';
import { config } from '../../config/index.js';

export const SESSION_COOKIE = 'novaciel_session';

/** Flags shared by the login cookie and the cookie that clears it. */
export function sessionCookieOptions(secure: boolean): CookieSerializeOptions {
  return { httpOnly: true, sameSite: 'lax', path: '/', secure };
}

export function sessionMaxAgeSeconds(): number {
  return config.SESSION_TTL_HOURS * 3600;
}
