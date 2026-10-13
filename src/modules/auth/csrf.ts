import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Per-route opt-in to other content types (for example multipart uploads). */
    csrf?: { allowedContentTypes?: string[] };
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const JSON_TYPE = 'application/json';

function mimeType(header: string | undefined): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * CSRF guard for state-changing requests (any method but GET, HEAD and OPTIONS):
 * - Content-Type must be application/json, unless the route lists more types in
 *   `config: { csrf: { allowedContentTypes: [...] } }`;
 * - when an Origin header is present it must match the allowed origin (always, for every type).
 *
 * A request without Origin is allowed: with SameSite=Lax a cross-site POST does not carry the
 * session cookie, so it cannot act as the user, and non-browser clients send no Origin.
 */
export function createCsrfGuard(allowedOrigin: string) {
  return async function csrfGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (SAFE_METHODS.has(req.method)) return;
    const allowed = [JSON_TYPE, ...(req.routeOptions.config?.csrf?.allowedContentTypes ?? [])];
    if (!allowed.includes(mimeType(req.headers['content-type']))) {
      return reply.code(415).send({ error: 'unsupported_media_type' });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== allowedOrigin) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
  };
}
