import { PgBoss } from 'pg-boss';
import { config } from '../config/index.js';
import { crearColasRecordatorios, createPgBossRecordatorios, type Recordatorios } from '../modules/aprobaciones/index.js';

/**
 * Opens a pg-boss of its own on DATABASE_URL (the same "pgboss" schema as the server), makes sure the
 * reminder queues exist, hands out the real reminders port, and ALWAYS stops the boss at the end. The
 * scripts only ENQUEUE: no worker runs here, so the jobs stay queued for the server to deliver. The
 * maintenance and scheduling loops are off: a script is not a queue supervisor.
 */
export async function withDevRecordatorios<T>(fn: (recordatorios: Recordatorios) => Promise<T>): Promise<T> {
  const boss = new PgBoss({ connectionString: config.DATABASE_URL, supervise: false, schedule: false });
  boss.on('error', (error) => console.error(`pg-boss error: ${error instanceof Error ? error.name : 'unknown'}`));
  await boss.start();
  try {
    await crearColasRecordatorios(boss);
    return await fn(createPgBossRecordatorios(boss));
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}
