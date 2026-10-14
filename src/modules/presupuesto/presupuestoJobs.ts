import type { PgBoss } from 'pg-boss';
import type { Db } from '../../db/types.js';
import { logger } from '../../lib/logger/index.js';
import { expireStaleReservations } from './presupuestoService.js';

export const EXPIRE_RESERVATIONS_QUEUE = 'expire-budget-reservations';
export const EXPIRE_RESERVATIONS_CRON = '*/5 * * * *';

/** Registers the job that expires stale budget reservations, every 5 minutes. Call after boss.start(). */
export async function registerBudgetJobs(boss: PgBoss, db: Db): Promise<void> {
  await boss.createQueue(EXPIRE_RESERVATIONS_QUEUE);
  await boss.schedule(EXPIRE_RESERVATIONS_QUEUE, EXPIRE_RESERVATIONS_CRON);
  await boss.work(EXPIRE_RESERVATIONS_QUEUE, async () => {
    const expired = await expireStaleReservations(db);
    if (expired > 0) logger.info({ expired }, 'expired stale budget reservations');
  });
}
