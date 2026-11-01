import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { producibleWorld } from '../../../tests/utils/produccionWorld.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { getPieza } from '../piezas/index.js';
import { producirPieza, type ControlCalidadEncolador } from '../produccion/index.js';
import {
  CONTROL_CALIDAD_QUEUE,
  crearColaControlCalidad,
  createPgBossControlCalidad,
  createPgBossControlCalidadQueue,
  ejecutarJobControlCalidad,
  registerControlCalidadJobs,
  singletonKeyControlCalidad,
} from './controlCalidadJobs.js';

const SISTEMA = { tipo: 'sistema' } as const;
const NO_PIEZA = '99999999-9999-4999-8999-999999999999';
const COPY = 'Hecho con calma'; // a piece of the copy of the fictional piece

function logsOf() {
  const logs: string[] = [];
  return { logs, logger: createLogger('debug', { write: (l: string) => void logs.push(l) }) };
}

/** A port that only records what the production transaction asks for. */
class RecordingPort implements ControlCalidadEncolador {
  readonly pedidos: { clienteId: string; piezaId: string; produccionId: string }[] = [];
  async encolar(_tx: Db, input: { clienteId: string; piezaId: string; produccionId: string }): Promise<void> {
    this.pedidos.push(input);
  }
}

describe('ejecutarJobControlCalidad', () => {
  it('controls the piece as the system and leaves a content-free output', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db, { sinCifras: true });
      const port = new RecordingPort();
      await producirPieza({ db, storage: w.storage, controlCalidad: port }, w.clienteId, w.piezaId, SISTEMA);
      expect(port.pedidos).toHaveLength(1);

      const { logs, logger } = logsOf();
      const output = await ejecutarJobControlCalidad({ db, storage: w.storage, logger }, port.pedidos[0], 'job-1');
      expect(output).toEqual({ resultado: 'control_realizado', revision_id: expect.any(String), qc: 'aprobado', codigos_fallo: [] });
      expect((await getPieza(db, w.clienteId, w.piezaId))!.estado).toBe('revision_novaciel');
      // Ids, results and codes only.
      expect(JSON.stringify(output) + logs.join('\n')).not.toContain(COPY);
    });
  });

  it('a rejection by QC is a normal result: the job completes with the failed codes', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db, { sinCifras: true });
      const port = new RecordingPort();
      const { produccion } = await producirPieza({ db, storage: w.storage, controlCalidad: port }, w.clienteId, w.piezaId, SISTEMA);
      await w.storage.put(produccion.archivos[0]!.clave_almacenamiento, Buffer.from('otro contenido'));
      const output = await ejecutarJobControlCalidad({ db, storage: w.storage }, port.pedidos[0]);
      expect(output).toMatchObject({ resultado: 'control_realizado', qc: 'rechazado' });
      expect(output.codigos_fallo).toContain('archivo_hash_distinto');
      expect((await getPieza(db, w.clienteId, w.piezaId))!.estado).toBe('en_produccion');
    });
  });

  it('ends "rechazado" with the error name for every expected refusal, storing nothing', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db, { sinCifras: true });
      const port = new RecordingPort();
      await producirPieza({ db, storage: w.storage, controlCalidad: port }, w.clienteId, w.piezaId, SISTEMA);
      const deps = { db, storage: w.storage };
      const pedido = port.pedidos[0]!;

      expect(await ejecutarJobControlCalidad(deps, { ...pedido, produccionId: NO_PIEZA })).toEqual({ resultado: 'rechazado', codigo: 'QcProduccionCambioError' });
      expect(await ejecutarJobControlCalidad(deps, { ...pedido, piezaId: NO_PIEZA })).toEqual({ resultado: 'rechazado', codigo: 'PiezaNotFoundError' });
      expect(await ejecutarJobControlCalidad(deps, { ...pedido, extra: 1 })).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
      expect(await ejecutarJobControlCalidad(deps, null)).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
      expect(Number((await db.query('SELECT count(*) AS n FROM revisiones_calidad WHERE cliente_id = $1', [w.clienteId])).rows[0].n)).toBe(0);

      // Run twice: the second finds the piece past quality control.
      expect(await ejecutarJobControlCalidad(deps, pedido)).toMatchObject({ resultado: 'control_realizado' });
      expect(await ejecutarJobControlCalidad(deps, pedido)).toEqual({ resultado: 'rechazado', codigo: 'QcEstadoInvalidoError' });
    });
  });

  it('lets an unexpected failure (a database outage) fail the job, logging the error name only', async () => {
    const { logs, logger } = logsOf();
    const caida = { query: async () => Promise.reject(new Error('connection lost: ' + COPY)) } as unknown as Db;
    const data = { clienteId: NO_PIEZA, piezaId: NO_PIEZA, produccionId: NO_PIEZA };
    await expect(ejecutarJobControlCalidad({ db: caida, storage: { getFile: async () => Promise.reject(new Error('x')) }, logger }, data, 'job-2')).rejects.toThrow('connection lost');
    expect(logs.join('\n')).toContain('quality control job failed');
    expect(logs.join('\n')).not.toContain(COPY);
  });
});

// ---- The real pg-boss, against the test database, in a schema of its own that the test drops.

const SCHEMA = 'pgboss_control_calidad_test';
const jobsDe = (boss: PgBoss, key: string) => boss.findJobs(CONTROL_CALIDAD_QUEUE, { key });

describe('the QC job and the production transaction, with the real pg-boss', () => {
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: SCHEMA });
  boss.on('error', () => undefined);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await getTestPool().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  async function finished(key: string) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const job = (await jobsDe(boss, key))[0];
      if (job && (job.state === 'completed' || job.state === 'failed')) return job;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('the job did not finish in time');
  }

  it('is queued atomically with the production (a rollback leaves none), once per production, and runs QC by itself', async () => {
    const pool = getTestPool();
    await cleanupDomainTables(pool);
    // Committed data (the worker uses its own connections), built with the factories.
    const w = await producibleWorld(pool, { sinCifras: true });
    const rolledBack = await producibleWorld(pool, { base: { clienteId: w.clienteId, planId: w.planId, perfilId: w.perfilId, storage: w.storage }, sinCifras: true });
    await boss.start();
    await crearColaControlCalidad(boss); // the queue exists, no worker yet: the jobs stay queued so they can be observed
    const puerto = createPgBossControlCalidad(boss);

    // Rollback: the real port queues INSIDE the production transaction, then something fails.
    const pedidos: { produccionId: string }[] = [];
    const queDespuesFalla: ControlCalidadEncolador = {
      async encolar(tx, input) {
        await puerto.encolar(tx, input);
        pedidos.push(input);
        throw new Error('forced failure after queuing');
      },
    };
    await expect(producirPieza({ db: pool, storage: w.storage, controlCalidad: queDespuesFalla }, w.clienteId, rolledBack.piezaId, SISTEMA)).rejects.toThrow('forced failure');
    expect((await getPieza(pool, w.clienteId, rolledBack.piezaId))!.estado).toBe('guion_listo');
    expect(pedidos).toHaveLength(1);
    expect(await jobsDe(boss, singletonKeyControlCalidad(w.clienteId, pedidos[0]!.produccionId))).toHaveLength(0);

    // Commit: one job, with ids only, in the same transaction as the production.
    const { produccion } = await producirPieza({ db: pool, storage: w.storage, controlCalidad: puerto }, w.clienteId, w.piezaId, SISTEMA);
    const key = singletonKeyControlCalidad(w.clienteId, produccion.id);
    const queued = await jobsDe(boss, key);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.data).toEqual({ clienteId: w.clienteId, piezaId: w.piezaId, produccionId: produccion.id });
    expect(queued[0]!.state).toBe('created');

    // No duplicates: the re-run queue refuses the same production while its job is queued.
    const cola = createPgBossControlCalidadQueue(boss);
    expect(await cola.enqueue({ clienteId: w.clienteId, piezaId: w.piezaId, produccionId: produccion.id })).toBeNull();
    expect(await jobsDe(boss, key)).toHaveLength(1);

    // The worker takes it and controls the piece.
    await registerControlCalidadJobs(boss, { db: pool, storage: w.storage });
    const done = await finished(key);
    expect(done.state).toBe('completed');
    expect(done.output).toMatchObject({ resultado: 'control_realizado', qc: 'aprobado', codigos_fallo: [] });
    expect((await getPieza(pool, w.clienteId, w.piezaId))!.estado).toBe('revision_novaciel');

    // A domain refusal is not a failure and is not retried: running it again for the same production ends "rechazado".
    const again = await cola.enqueue({ clienteId: w.clienteId, piezaId: w.piezaId, produccionId: produccion.id });
    expect(again).not.toBeNull();
    const second = await boss.getJobById(CONTROL_CALIDAD_QUEUE, again!);
    expect(second).not.toBeNull();
    const deadline = Date.now() + 30_000;
    let job = second;
    while (Date.now() < deadline && job?.state !== 'completed' && job?.state !== 'failed') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      job = await boss.getJobById(CONTROL_CALIDAD_QUEUE, again!);
    }
    expect(job?.state).toBe('completed');
    expect(job?.output).toEqual({ resultado: 'rechazado', codigo: 'QcEstadoInvalidoError' });
  }, 90_000);
});
