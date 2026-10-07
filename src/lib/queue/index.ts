import { PgBoss } from 'pg-boss';
import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';

export const PING_QUEUE = 'ping';

export interface PingPayload {
  message: string;
}

export function createQueue(): PgBoss {
  const boss = new PgBoss(config.DATABASE_URL);
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  return boss;
}

export async function startQueue(boss: PgBoss): Promise<void> {
  await boss.start();
  await boss.createQueue(PING_QUEUE);
  await boss.work<PingPayload>(PING_QUEUE, async (jobs) => {
    for (const job of jobs) {
      logger.info({ jobId: job.id, data: job.data }, 'ping job executed');
    }
  });
}

export async function enqueuePing(boss: PgBoss, message = 'ping'): Promise<string | null> {
  return boss.send(PING_QUEUE, { message } satisfies PingPayload);
}
