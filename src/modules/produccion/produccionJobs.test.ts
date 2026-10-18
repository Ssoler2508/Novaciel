import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { producibleWorld } from '../../../tests/utils/produccionWorld.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { createLogger } from '../../lib/logger/index.js';
import { getPieza } from '../piezas/index.js';
import {
  createPgBossProduccionQueue,
  ejecutarJobProducirPieza,
  ejecutarJobProducirPlan,
  PRODUCIR_PIEZA_QUEUE,
  PRODUCIR_PLAN_QUEUE,
  registerProduccionJobs,
  singletonKeyPieza,
  singletonKeyPlan,
} from './produccionJobs.js';
import { getProduccionActual } from './produccionRepository.js';

const NO_PIEZA = '99999999-9999-4999-8999-999999999999';

function logsOf() {
  const logs: string[] = [];
  return { logs, logger: createLogger('debug', { write: (l: string) => void logs.push(l) }) };
}

describe('ejecutarJobProducirPieza', () => {
  it('produces the piece as the system and returns a content-free output', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db);
      const { logs, logger } = logsOf();
      const output = await ejecutarJobProducirPieza({ db, storage: w.storage, logger }, { clienteId: w.clienteId, piezaId: w.piezaId }, 'job-1');

      const produccion = (await getProduccionActual(db, w.clienteId, w.piezaId))!;
      expect(output).toEqual({ resultado: 'produccion_creada', produccion_id: produccion.id, version: 1, archivos: 5, hash_pieza: produccion.hash_pieza });
      expect(produccion.creado_por).toBeNull();
      expect((await getPieza(db, w.clienteId, w.piezaId))!.estado).toBe('en_control_calidad');

      // Metadata only: no copy, no file keys.
      const everything = JSON.stringify(output) + logs.join('\n');
      expect(everything).not.toContain('Hecho con calma');
      expect(everything).not.toContain('producidos/');
      expect(everything).not.toContain('Escena');
    });
  });

  it('re-produces with reproducir and refuses a second production without it', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db);
      const deps = { db, storage: w.storage };
      const data = { clienteId: w.clienteId, piezaId: w.piezaId };
      await ejecutarJobProducirPieza(deps, data);
      expect(await ejecutarJobProducirPieza(deps, data)).toEqual({ resultado: 'rechazado', codigo: 'ProduccionExistenteError' });
      expect(await ejecutarJobProducirPieza(deps, { ...data, reproducir: true })).toMatchObject({ resultado: 'produccion_creada', version: 2 });
    });
  });

  it('ends "rechazado" with the error name for every expected refusal, storing nothing', async () => {
    await withTestTransaction(async (db) => {
      const faltante = await producibleWorld(db, { faltantes: [2] });
      const sinTamano = await producibleWorld(db, { red: 'tiktok' });
      const pequena = await producibleWorld(db, { source: [640, 480] });
      const deps = (w: { storage: typeof faltante.storage }) => ({ db, storage: w.storage });

      expect(await ejecutarJobProducirPieza(deps(faltante), { clienteId: faltante.clienteId, piezaId: faltante.piezaId })).toEqual({ resultado: 'rechazado', codigo: 'BriefConFaltantesError' });
      expect(await ejecutarJobProducirPieza(deps(sinTamano), { clienteId: sinTamano.clienteId, piezaId: sinTamano.piezaId })).toEqual({ resultado: 'rechazado', codigo: 'FormatoNoSoportadoError' });
      expect(await ejecutarJobProducirPieza(deps(faltante), { clienteId: faltante.clienteId, piezaId: NO_PIEZA })).toEqual({ resultado: 'rechazado', codigo: 'PiezaNotFoundError' });

      // Small sources: the ids and slide numbers (and nothing else) travel in the output.
      const output = await ejecutarJobProducirPieza(deps(pequena), { clienteId: pequena.clienteId, piezaId: pequena.piezaId });
      expect(output).toEqual({
        resultado: 'rechazado',
        codigo: 'FuentesMuyPequenasError',
        fuentes_pequenas: { media_ids: pequena.media.map((m) => m.id), ordenes: [1, 2, 3, 4, 5] },
      });
      for (const w of [faltante, sinTamano, pequena]) expect(w.storage.keys().filter((k) => k.includes('/producidos/'))).toEqual([]);
      expect((await getPieza(db, pequena.clienteId, pequena.piezaId))!.estado).toBe('guion_listo');
    });
  });

  it("refuses another client's piece and a bad payload", async () => {
    await withTestTransaction(async (db) => {
      const a = await producibleWorld(db);
      const b = await producibleWorld(db);
      expect(await ejecutarJobProducirPieza({ db, storage: a.storage }, { clienteId: b.clienteId, piezaId: a.piezaId })).toEqual({ resultado: 'rechazado', codigo: 'PiezaNotFoundError' });
      expect((await getPieza(db, a.clienteId, a.piezaId))!.estado).toBe('guion_listo');
      expect(await getProduccionActual(db, a.clienteId, a.piezaId)).toBeNull();
      for (const bad of [null, {}, { clienteId: a.clienteId }, { clienteId: 'x', piezaId: a.piezaId }, { clienteId: a.clienteId, piezaId: a.piezaId, extra: 1 }]) {
        expect(await ejecutarJobProducirPieza({ db, storage: a.storage }, bad)).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
      }
    });
  });

  it('lets an unexpected failure (a storage outage) fail the job, with the piece unchanged', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db);
      w.storage.putFile = async () => {
        throw new Error('disk full');
      };
      await expect(ejecutarJobProducirPieza({ db, storage: w.storage }, { clienteId: w.clienteId, piezaId: w.piezaId })).rejects.toThrow('disk full');
      expect((await getPieza(db, w.clienteId, w.piezaId))!.estado).toBe('guion_listo');
    });
  });
});

describe('ejecutarJobProducirPlan', () => {
  it('produces every piece waiting in guion_listo; one that cannot be produced is reported and does not stop the rest', async () => {
    await withTestTransaction(async (db) => {
      const first = await producibleWorld(db);
      const base = { clienteId: first.clienteId, planId: first.planId, perfilId: first.perfilId, storage: first.storage };
      const second = await producibleWorld(db, { base, formato: 'post' });
      const faltante = await producibleWorld(db, { base, faltantes: [3] });
      const output = await ejecutarJobProducirPlan({ db, storage: first.storage }, { clienteId: first.clienteId, planId: first.planId });

      expect(output.resultado).toBe('plan_producido');
      expect(output.resumen).toEqual({ ok: 2, fallidas: 1 });
      expect(output.piezas).toHaveLength(3);
      expect(output.piezas).toEqual(
        expect.arrayContaining([
          { pieza_id: first.piezaId, resultado: 'ok', version: 1 },
          { pieza_id: second.piezaId, resultado: 'ok', version: 1 },
          { pieza_id: faltante.piezaId, resultado: 'fallida', codigo: 'BriefConFaltantesError' },
        ]),
      );
      expect((await getPieza(db, first.clienteId, faltante.piezaId))!.estado).toBe('guion_listo');

      // A second run only sees the piece that is still waiting.
      const again = await ejecutarJobProducirPlan({ db, storage: first.storage }, { clienteId: first.clienteId, planId: first.planId });
      expect(again.resumen).toEqual({ ok: 0, fallidas: 1 });
    });
  });

  it('rejects a plan of another client, an unapproved plan and a bad payload', async () => {
    await withTestTransaction(async (db) => {
      const a = await producibleWorld(db);
      const b = await producibleWorld(db);
      expect(await ejecutarJobProducirPlan({ db, storage: a.storage }, { clienteId: b.clienteId, planId: a.planId })).toEqual({ resultado: 'rechazado', codigo: 'PlanNotFoundError' });
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1 AND cliente_id = $2`, [a.planId, a.clienteId]);
      expect(await ejecutarJobProducirPlan({ db, storage: a.storage }, { clienteId: a.clienteId, planId: a.planId })).toEqual({ resultado: 'rechazado', codigo: 'PlanDescartadoError' });
      expect(await ejecutarJobProducirPlan({ db, storage: a.storage }, { clienteId: a.clienteId })).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
    });
  });
});

// ---- The real pg-boss, against the test database, in schemas of their own that the tests drop.

function newBoss(schema: string): PgBoss {
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
  boss.on('error', () => undefined);
  return boss;
}
const dropSchema = (schema: string) => getTestPool().query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);

describe('the singleton keys and the plan lookup, with the real pg-boss', () => {
  const SCHEMA = 'pgboss_produccion_singleton_test';
  const boss = newBoss(SCHEMA);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await dropSchema(SCHEMA);
  });

  it('allows one queued job per piece and per plan, finds the active plan job, and reads jobs of both queues', async () => {
    await boss.start();
    // The queues only, with no worker: the jobs stay queued so the policy can be observed.
    await boss.createQueue(PRODUCIR_PIEZA_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
    await boss.createQueue(PRODUCIR_PLAN_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 1800 });
    const queue = createPgBossProduccionQueue(boss);
    const clienteA = '11111111-1111-4111-8111-111111111111';
    const clienteB = '22222222-2222-4222-8222-222222222222';
    const planA = '33333333-3333-4333-8333-333333333333';
    const piezaA = '55555555-5555-4555-8555-555555555555';

    expect(await queue.findActivePlanJob(clienteA, planA)).toBeNull();
    const plan1 = await queue.enqueuePlan({ clienteId: clienteA, planId: planA });
    expect(plan1).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(await queue.enqueuePlan({ clienteId: clienteA, planId: planA })).toBeNull();
    expect(await queue.enqueuePlan({ clienteId: clienteB, planId: planA })).not.toBeNull();

    const piece1 = await queue.enqueuePieza({ clienteId: clienteA, piezaId: piezaA });
    expect(piece1).not.toBeNull();
    expect(await queue.enqueuePieza({ clienteId: clienteA, piezaId: piezaA, reproducir: true })).toBeNull();

    expect(singletonKeyPlan(clienteA, planA)).toBe(`${clienteA}:${planA}`);
    expect(singletonKeyPieza(clienteA, piezaA)).toBe(`${clienteA}:${piezaA}`);
    expect(await queue.findActivePlanJob(clienteA, planA)).toBe(plan1);
    expect(await queue.findActivePlanJob(clienteB, '66666666-6666-4666-8666-666666666666')).toBeNull();

    expect(await queue.getJob(plan1!)).toEqual({ tipo: 'plan', estado: 'created', clienteId: clienteA, output: null });
    expect(await queue.getJob(piece1!)).toEqual({ tipo: 'pieza', estado: 'created', clienteId: clienteA, output: null });
    expect(await queue.getJob('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('the workers, with the real pg-boss', () => {
  const SCHEMA = 'pgboss_produccion_worker_test';
  const boss = newBoss(SCHEMA);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await dropSchema(SCHEMA);
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  async function finished(jobId: string) {
    const queue = createPgBossProduccionQueue(boss);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const job = await queue.getJob(jobId);
      if (job && (job.estado === 'completed' || job.estado === 'failed')) return job;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('the job did not finish in time');
  }

  it('runs the piece job and the plan job, stores the productions, and never retries a failed job', async () => {
    const pool = getTestPool();
    await cleanupDomainTables(pool);
    // Committed data (the worker uses its own connections), built with the factories (no audit rows).
    const one = await producibleWorld(pool);
    const base = { clienteId: one.clienteId, planId: one.planId, perfilId: one.perfilId, storage: one.storage };
    const two = await producibleWorld(pool, { base });
    const three = await producibleWorld(pool, { base, formato: 'post' });

    await boss.start();
    await registerProduccionJobs(boss, { db: pool, storage: one.storage });
    const queue = createPgBossProduccionQueue(boss);

    const pieceJob = await queue.enqueuePieza({ clienteId: one.clienteId, piezaId: one.piezaId });
    expect(pieceJob).not.toBeNull();
    const done = await finished(pieceJob!);
    expect(done).toMatchObject({ tipo: 'pieza', estado: 'completed', clienteId: one.clienteId });
    expect(done.output).toMatchObject({ resultado: 'produccion_creada', version: 1, archivos: 5 });
    expect((await getProduccionActual(pool, one.clienteId, one.piezaId))!.version).toBe(1);
    expect(await queue.findActivePlanJob(one.clienteId, one.planId)).toBeNull();

    const planJob = await queue.enqueuePlan({ clienteId: one.clienteId, planId: one.planId });
    expect(planJob).not.toBeNull();
    const planDone = await finished(planJob!);
    expect(planDone.output).toMatchObject({ resultado: 'plan_producido', resumen: { ok: 2, fallidas: 0 } });
    for (const w of [two, three]) expect((await getPieza(pool, w.clienteId, w.piezaId))!.estado).toBe('en_control_calidad');

    // A storage outage fails the job and is NOT retried (retryLimit 0): the piece stays where it was.
    const four = await producibleWorld(pool, { base });
    one.storage.putFile = async () => {
      throw new Error('disk full');
    };
    const failing = await queue.enqueuePieza({ clienteId: one.clienteId, piezaId: four.piezaId });
    expect((await finished(failing!)).estado).toBe('failed');
    expect((await getPieza(pool, four.clienteId, four.piezaId))!.estado).toBe('guion_listo');
  }, 90_000);
});
