import Fastify from 'fastify';
import { config } from './config/index.js';
import { closePool, pool } from './db/pool.js';
import { logger } from './lib/logger/index.js';
import { createQueue, enqueuePing, startQueue } from './lib/queue/index.js';
import {
  createStorage,
  LocalFileStorage,
  registerLocalFileRoute,
} from './lib/media/storage/index.js';

const app = Fastify({ loggerInstance: logger });
const boss = createQueue();
export const storage = createStorage(config.storage);

if (storage instanceof LocalFileStorage) {
  registerLocalFileRoute(app, storage);
}

app.get('/health', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    const queues = await boss.getQueues();
    return { status: 'ok', db: 'ok', queue: 'ok', queues: queues.length };
  } catch (err) {
    app.log.error({ err }, 'health check failed');
    return reply.code(503).send({ status: 'error' });
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await boss.stop();
    await closePool();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  await startQueue(boss);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  await enqueuePing(boss, 'startup');
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
