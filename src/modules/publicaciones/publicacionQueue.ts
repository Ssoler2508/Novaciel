import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '../../db/types.js';

// The queues of publishing (Step 10, checkpoint D) and the port the services use to queue the send.
// Payloads carry ids and the scheduled time only: never a caption, a file or a credential.

export const PUBLICAR_QUEUE = 'publicacion-publicar';
export const BARRIDO_QUEUE = 'publicacion-barrido';
export const METRICAS_QUEUE = 'publicacion-metricas';

/** The sweeps run every minute / every 15 minutes (VERIFY). */
export const BARRIDO_CRON = '* * * * *';
export const METRICAS_CRON = '*/15 * * * *';

export const payloadPublicarSchema = z
  .object({
    clienteId: z.uuid(),
    piezaId: z.uuid(),
    produccionId: z.uuid(),
    /** The scheduled time the job was queued for. If the piece's time changed, the job does nothing. */
    fechaHora: z.iso.datetime(),
    /** 0 for the scheduled send; n for the retry after the n-th failed attempt. */
    ronda: z.number().int().min(0).max(10),
  })
  .strict();
export type PayloadPublicar = z.infer<typeof payloadPublicarSchema>;

/** One job per piece, production, scheduled time and round. A reschedule or a retry is a different job. */
export const singletonKeyPublicar = (p: PayloadPublicar) => `${p.clienteId}:${p.piezaId}:${p.produccionId}:${Date.parse(p.fechaHora)}:${p.ronda}`;

export interface PublicacionQueue {
  /** Queues the scheduled send INSIDE the caller's transaction, so it exists if and only if the schedule committed. */
  programar(tx: Db, payload: PayloadPublicar, cuando: Date): Promise<void>;
  /** Queues a send outside any transaction (a retry, or the sweep's safety net). */
  reencolar(payload: PayloadPublicar, cuando: Date): Promise<void>;
}

/** Test port: records what is asked for, queues nothing. */
export class FakePublicacionQueue implements PublicacionQueue {
  readonly programados: { payload: PayloadPublicar; cuando: Date }[] = [];
  readonly reencolados: { payload: PayloadPublicar; cuando: Date }[] = [];

  async programar(_tx: Db, payload: PayloadPublicar, cuando: Date): Promise<void> {
    this.programados.push({ payload, cuando });
  }

  async reencolar(payload: PayloadPublicar, cuando: Date): Promise<void> {
    this.reencolados.push({ payload, cuando });
  }
}

/** Creates the three queues (idempotent). Publish jobs are exclusive per key and never retried by pg-boss itself. */
export async function crearColasPublicacion(boss: PgBoss): Promise<void> {
  await boss.createQueue(PUBLICAR_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
  await boss.createQueue(BARRIDO_QUEUE, { retryLimit: 0, expireInSeconds: 600 });
  await boss.createQueue(METRICAS_QUEUE, { retryLimit: 0, expireInSeconds: 900 });
}

/** The real port. `programar` sends the job THROUGH THE CALLER'S TRANSACTION (pg-boss's `db` option). */
export function createPgBossPublicacionQueue(boss: PgBoss): PublicacionQueue {
  const enTransaccion = (tx: Db) => ({ executeSql: async (text: string, values?: unknown[]) => ({ rows: (await tx.query(text, values as never[])).rows }) });
  return {
    async programar(tx, payload, cuando) {
      await boss.send(PUBLICAR_QUEUE, payload, { startAfter: cuando, singletonKey: singletonKeyPublicar(payload), db: enTransaccion(tx) });
    },
    async reencolar(payload, cuando) {
      await boss.send(PUBLICAR_QUEUE, payload, { startAfter: cuando, singletonKey: singletonKeyPublicar(payload) });
    },
  };
}
