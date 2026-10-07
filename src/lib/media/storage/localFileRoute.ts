import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import { validateKey } from './keys.js';
import type { LocalFileStorage } from './localFileStorage.js';

// The logger type parameter is `any` so apps using a custom pino instance can register the route.
type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  any
>;

/** GET /files/<key>?expires=<unix>&sig=<hmac>: serves files for URLs from LocalFileStorage. */
export function registerLocalFileRoute(app: App, storage: LocalFileStorage): void {
  app.get<{ Params: { '*': string }; Querystring: { expires?: string; sig?: string } }>(
    '/files/*',
    async (req, reply) => {
      const key = req.params['*'];
      const { expires, sig } = req.query;
      if (typeof expires !== 'string' || !/^\d+$/.test(expires) || typeof sig !== 'string') {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      try {
        validateKey(key);
      } catch {
        return reply.code(400).send({ error: 'invalid_key' });
      }
      if (!storage.verify(key, Number(expires), sig)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (!(await storage.exists(key))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply
        .header('Content-Type', storage.contentTypeFor(key))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=0')
        .send(storage.openReadStream(key));
    },
  );
}
