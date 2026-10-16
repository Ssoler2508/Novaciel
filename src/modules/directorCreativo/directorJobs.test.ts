import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { briefJson, countRows, ledger, piece, SECRET_TEXTS, world } from '../../../tests/utils/directorWorld.js';
import {
  createCliente,
  createConfiguracionGastoCliente,
  createGuion,
  createPerfilMarca,
  createPieza,
  createPlanSemanal,
  createPrecioModelo,
  createReglaProhibida,
  createUsuario,
  moverPieza,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeAlertSink } from '../../lib/ai/alerts.js';
import { FakeLLMProvider } from '../../lib/ai/fakeLLMProvider.js';
import { SEED_IDIOMA, SEED_PROFILE } from '../../scripts/seedProfile.js';
import { pausarPieza, getPieza } from '../piezas/index.js';
import { asClienteId } from '../shared/clienteId.js';
import {
  createPgBossBriefQueue,
  ejecutarJobBriefPieza,
  ejecutarJobBriefsPlan,
  GENERAR_BRIEF_PIEZA_QUEUE,
  GENERAR_BRIEFS_PLAN_QUEUE,
  registerDirectorJobs,
  singletonKeyPieza,
  singletonKeyPlan,
} from './directorJobs.js';
import { getBriefActual } from './guionesRepository.js';

const SISTEMA = { tipo: 'sistema' } as const;

describe('ejecutarJobBriefsPlan', () => {
  it('stores the briefs of the eligible pieces as the system and returns a content-free output', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const a = await piece(w, { fechaHora: new Date(Date.now() + 3 * 24 * 3600_000) });
      const b = await piece(w, { fechaHora: new Date(Date.now() + 3 * 24 * 3600_000 + 3600_000) });
      const yaTiene = await piece(w, { fechaHora: new Date(Date.now() + 3 * 24 * 3600_000 + 7200_000) });
      await createGuion(db, { piezaId: yaTiene.id });
      await moverPieza(db, yaTiene.id, 'guion_listo');
      const pausada = await piece(w, { fechaHora: new Date(Date.now() + 3 * 24 * 3600_000 + 10_800_000) });
      await pausarPieza(db, w.clienteId, pausada.id, SISTEMA);
      w.provider.enqueue(briefJson(w), briefJson(w, { media: w.photos.slice(1, 6).map((m) => m.id) }));

      const output = await ejecutarJobBriefsPlan(w.deps, { clienteId: w.clienteId, planId: w.planId }, 'job-1');

      expect(output).toEqual({
        resultado: 'briefs_generados',
        resumen: { ok: 2, omitidas: 2, fallidas: 0, detenido_por_presupuesto: false },
        piezas: [
          { pieza_id: a.id, resultado: 'ok', version: 1 },
          { pieza_id: b.id, resultado: 'ok', version: 1 },
          { pieza_id: yaTiene.id, resultado: 'omitida', motivo: 'ya_tiene_guion' },
          { pieza_id: pausada.id, resultado: 'omitida', motivo: 'estado_pausada' },
        ],
      });
      for (const text of SECRET_TEXTS) expect(JSON.stringify(output)).not.toContain(text);
      // The actor is the system.
      const audit = await db.query(`SELECT actor_tipo FROM auditoria WHERE tabla = 'guiones' AND accion = 'crear' AND cliente_id = $1`, [w.clienteId]);
      expect(audit.rows.map((r) => r.actor_tipo)).toEqual(['sistema', 'sistema']); // the two briefs of the job (the factory brief has no audit row)
      expect(w.provider.calls).toHaveLength(2);
    });
  });

  it('reports a failing piece inside the output without failing the job, and a budget stop', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const a = await piece(w, { fechaHora: new Date(Date.now() + 3 * 24 * 3600_000) });
      const b = await piece(w, { fechaHora: new Date(Date.now() + 3 * 24 * 3600_000 + 3600_000) });
      w.provider.enqueue('x', 'y', briefJson(w));
      const mixed = await ejecutarJobBriefsPlan(w.deps, { clienteId: w.clienteId, planId: w.planId });
      expect(mixed.resumen).toEqual({ ok: 1, omitidas: 0, fallidas: 1, detenido_por_presupuesto: false });
      expect(mixed.piezas).toEqual([
        { pieza_id: a.id, resultado: 'fallida', codigo: 'SchemaValidationError' },
        { pieza_id: b.id, resultado: 'ok', version: 1 },
      ]);

      const c = await piece(w, { fechaHora: new Date(Date.now() + 4 * 24 * 3600_000) });
      const d = await piece(w, { fechaHora: new Date(Date.now() + 4 * 24 * 3600_000 + 3600_000) });
      await db.query('UPDATE topes SET monto_techo = 0 WHERE cliente_id = $1', [w.clienteId]);
      const callsBefore = w.provider.calls.length;
      w.provider.enqueue(briefJson(w), briefJson(w));
      const stopped = await ejecutarJobBriefsPlan(w.deps, { clienteId: w.clienteId, planId: w.planId });
      // a (failed earlier, still plan_aprobado) is refused by the budget; once stopped, the rest are not even tried.
      expect(stopped.resumen).toMatchObject({ detenido_por_presupuesto: true, ok: 0 });
      expect(stopped.piezas![0]).toEqual({ pieza_id: a.id, resultado: 'fallida', codigo: 'BudgetRefusedError' });
      expect(stopped.piezas!.slice(1).map((p) => [p.pieza_id, p.resultado, p.motivo])).toEqual([
        [b.id, 'omitida', 'presupuesto'],
        [c.id, 'omitida', 'presupuesto'],
        [d.id, 'omitida', 'presupuesto'],
      ]);
      expect(w.provider.calls).toHaveLength(callsBefore);
    });
  });

  it('turns each expected domain error into a "rechazado" output with the error name', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      await piece(w);
      const run = (data: unknown) => ejecutarJobBriefsPlan(w.deps, data);

      const draft = await createPlanSemanal(db, { clienteId: w.clienteId, perfilMarcaId: w.perfilId, semanaInicio: '2026-11-16' });
      expect(await run({ clienteId: w.clienteId, planId: draft.id })).toEqual({ resultado: 'rechazado', codigo: 'PlanNoAprobadoError' });
      const stranger = (await createCliente(db)).id;
      expect(await run({ clienteId: stranger, planId: w.planId })).toEqual({ resultado: 'rechazado', codigo: 'PlanNotFoundError' });
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [w.planId]);
      expect(await run({ clienteId: w.clienteId, planId: w.planId })).toEqual({ resultado: 'rechazado', codigo: 'PlanDescartadoError' });
      expect(w.provider.calls).toHaveLength(0);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(0);
    });
  });

  it('rejects an invalid payload without touching anything', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      for (const data of [null, {}, { clienteId: w.clienteId }, { clienteId: 'x', planId: w.planId }, { clienteId: w.clienteId, planId: w.planId, extra: 1 }]) {
        expect(await ejecutarJobBriefsPlan(w.deps, data)).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
      }
      expect(w.provider.calls).toHaveLength(0);
    });
  });

  it('an unexpected error fails the job instead of hiding as a rejection', async () => {
    const broken = { query: () => Promise.reject(new Error('the database is down')) } as unknown as Db;
    const deps = { db: broken, provider: new FakeLLMProvider(), alerts: new FakeAlertSink() };
    await expect(ejecutarJobBriefsPlan(deps, { clienteId: '11111111-1111-4111-8111-111111111111', planId: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow('database is down');
  });

  it('logs ids, counts and error names only', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      await piece(w, { idea: 'Una idea única del planificador' });
      w.provider.enqueue(briefJson(w));
      await ejecutarJobBriefsPlan(w.deps, { clienteId: w.clienteId, planId: w.planId }, 'job-9');
      const logs = w.logs.join('\n');
      expect(logs).toContain('plan briefs job done');
      for (const text of [...SECRET_TEXTS, 'Una idea única', 'Cafetería Aurora', 'EXTERNAL_DATA', 'Nuestro barrio']) expect(logs, text).not.toContain(text);
    });
  });
});

describe('ejecutarJobBriefPieza', () => {
  it('creates the brief as the system and returns the guion id and version; regenerar makes version 2', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      w.provider.enqueue(briefJson(w), briefJson(w));
      const first = await ejecutarJobBriefPieza(w.deps, { clienteId: w.clienteId, piezaId: pieza.id });
      expect(first).toEqual({ resultado: 'brief_creado', guion_id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: 1 });
      expect((await getBriefActual(db, w.clienteId, pieza.id))!.id).toBe(first.guion_id);
      const second = await ejecutarJobBriefPieza(w.deps, { clienteId: w.clienteId, piezaId: pieza.id, regenerar: true });
      expect(second).toMatchObject({ resultado: 'brief_creado', version: 2 });
      expect(await ledger(db, w.clienteId)).toHaveLength(2);
    });
  });

  it('turns each expected domain error into a "rechazado" output with the error name', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      const run = (data: unknown) => ejecutarJobBriefPieza(w.deps, data);
      const stranger = (await createCliente(db)).id;

      expect(await run({ clienteId: stranger, piezaId: pieza.id })).toEqual({ resultado: 'rechazado', codigo: 'PiezaNotFoundError' });
      const enProduccion = await piece(w, { estado: 'en_produccion' });
      expect(await run({ clienteId: w.clienteId, piezaId: enProduccion.id })).toEqual({ resultado: 'rechazado', codigo: 'PiezaEstadoInvalidoError' });
      w.provider.enqueue('x', 'y');
      expect(await run({ clienteId: w.clienteId, piezaId: pieza.id })).toEqual({ resultado: 'rechazado', codigo: 'SchemaValidationError' });
      w.provider.enqueue(briefJson(w));
      expect(await run({ clienteId: w.clienteId, piezaId: pieza.id })).toMatchObject({ resultado: 'brief_creado' });
      expect(await run({ clienteId: w.clienteId, piezaId: pieza.id })).toEqual({ resultado: 'rechazado', codigo: 'BriefExistenteError' });
      await db.query('UPDATE topes SET monto_techo = 0 WHERE cliente_id = $1', [w.clienteId]);
      const otra = await piece(w);
      expect(await run({ clienteId: w.clienteId, piezaId: otra.id })).toEqual({ resultado: 'rechazado', codigo: 'BudgetRefusedError' });
      expect((await getPieza(db, w.clienteId, otra.id))!.estado).toBe('plan_aprobado');
    });
  });

  it('rejects an invalid payload; an unexpected error fails the job', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      for (const data of [null, {}, { clienteId: w.clienteId }, { clienteId: w.clienteId, piezaId: 'x' }, { clienteId: w.clienteId, piezaId: w.planId, regenerar: 'si' }]) {
        expect(await ejecutarJobBriefPieza(w.deps, data)).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
      }
    });
    const broken = { query: () => Promise.reject(new Error('the database is down')) } as unknown as Db;
    await expect(
      ejecutarJobBriefPieza({ db: broken, provider: new FakeLLMProvider(), alerts: new FakeAlertSink() }, { clienteId: '11111111-1111-4111-8111-111111111111', piezaId: '22222222-2222-4222-8222-222222222222' }),
    ).rejects.toThrow('database is down');
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
  const SCHEMA = 'pgboss_director_singleton_test';
  const boss = newBoss(SCHEMA);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await dropSchema(SCHEMA);
  });

  it('allows one queued job per plan and per piece, finds the active plan job, and reads jobs of both queues', async () => {
    await boss.start();
    // The queues only, with no worker: the jobs stay queued so the policy can be observed.
    await boss.createQueue(GENERAR_BRIEFS_PLAN_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 1800 });
    await boss.createQueue(GENERAR_BRIEF_PIEZA_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
    const queue = createPgBossBriefQueue(boss);
    const clienteA = '11111111-1111-4111-8111-111111111111';
    const clienteB = '22222222-2222-4222-8222-222222222222';
    const planA = '33333333-3333-4333-8333-333333333333';
    const planB = '44444444-4444-4444-8444-444444444444';
    const piezaA = '55555555-5555-4555-8555-555555555555';

    expect(await queue.findActivePlanJob(clienteA, planA)).toBeNull();
    const first = await queue.enqueuePlan({ clienteId: clienteA, planId: planA });
    expect(first).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(await queue.enqueuePlan({ clienteId: clienteA, planId: planA })).toBeNull(); // the same plan, in parallel
    expect(await queue.enqueuePlan({ clienteId: clienteA, planId: planB })).not.toBeNull();
    expect(await queue.enqueuePlan({ clienteId: clienteB, planId: planA })).not.toBeNull();

    const piece1 = await queue.enqueuePieza({ clienteId: clienteA, piezaId: piezaA });
    expect(piece1).not.toBeNull();
    expect(await queue.enqueuePieza({ clienteId: clienteA, piezaId: piezaA, regenerar: true })).toBeNull();

    expect(singletonKeyPlan(clienteA, planA)).toBe(`${clienteA}:${planA}`);
    expect(singletonKeyPieza(clienteA, piezaA)).toBe(`${clienteA}:${piezaA}`);

    // The lookup the piece route uses to answer 409 plan_en_proceso.
    expect(await queue.findActivePlanJob(clienteA, planA)).toBe(first);
    expect(await queue.findActivePlanJob(clienteA, '66666666-6666-4666-8666-666666666666')).toBeNull();
    expect(await queue.findActivePlanJob(clienteB, planB)).toBeNull();

    expect(await queue.getJob(first!)).toEqual({ tipo: 'plan', estado: 'created', clienteId: clienteA, output: null });
    expect(await queue.getJob(piece1!)).toEqual({ tipo: 'pieza', estado: 'created', clienteId: clienteA, output: null });
    expect(await queue.getJob('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('the workers, with the real pg-boss', () => {
  const SCHEMA = 'pgboss_director_worker_test';
  const boss = newBoss(SCHEMA);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await dropSchema(SCHEMA);
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  async function finished(jobId: string) {
    const queue = createPgBossBriefQueue(boss);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const job = await queue.getJob(jobId);
      if (job && (job.estado === 'completed' || job.estado === 'failed')) return job;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('the job did not finish in time');
  }

  it('runs the plan job and the piece job, stores the briefs, and a second plan run omits the pieces that have one', async () => {
    const pool = getTestPool();
    await cleanupDomainTables(pool);
    // Committed data: the worker uses its own connections. Built with the test factories (plain SQL,
    // no audit rows), NOT with the seed: the audit log is append-only and its rows would stay in the
    // test database for good.
    const user = await createUsuario(pool);
    const cliente = await createCliente(pool);
    const clienteId = asClienteId(cliente.id);
    const perfil = await createPerfilMarca(pool, { clienteId, creadoPor: user.id, idiomaContenido: SEED_IDIOMA, ...SEED_PROFILE });
    await createReglaProhibida(pool, { clienteId, tipo: 'palabra', texto: 'garantizado' });
    await createPrecioModelo(pool, { proveedor: 'fake', modelo: 'fake-model', precioEntrada: '1', precioSalida: '2' });
    await createConfiguracionGastoCliente(pool, { clienteId, techoMensualDefecto: '1' });
    const plan = await createPlanSemanal(pool, { clienteId, perfilMarcaId: perfil.id, estado: 'aprobado', semanaInicio: '2026-11-09' });
    const piezas = [
      await createPieza(pool, { clienteId, planId: plan.id, estado: 'plan_aprobado', formato: 'carrusel', fechaHora: new Date(Date.now() + 3 * 24 * 3600_000) }),
      await createPieza(pool, { clienteId, planId: plan.id, estado: 'plan_aprobado', formato: 'carrusel', fechaHora: new Date(Date.now() + 4 * 24 * 3600_000) }),
    ];
    const noMedia = JSON.stringify({
      formato: 'carrusel',
      gancho: 'El origen de tu café de hoy',
      escenas: Array.from({ length: 5 }, (_v, i) => ({
        orden: i + 1,
        texto_en_pantalla: 'Escena del origen',
        texto_alternativo: 'Granos de café sobre una mesa',
        toma: { media_id: null, motivo_faltante: 'No hay media adecuada' },
      })),
      texto_publicacion: { texto: 'Hecho con calma, como siempre.', hashtags: ['#cafe'] },
      llamado_a_accion: 'Pásate por tu café de hoy',
      notas_produccion: 'Mantener la luz natural',
      hechos_omitidos: [],
    });
    const provider = new FakeLLMProvider().enqueue(noMedia, noMedia, noMedia);

    await boss.start();
    await registerDirectorJobs(boss, { db: pool, provider, alerts: new FakeAlertSink() });
    const queue = createPgBossBriefQueue(boss);

    const planJob = await queue.enqueuePlan({ clienteId, planId: plan.id });
    expect(planJob).not.toBeNull();
    const done = await finished(planJob!);
    expect(done).toMatchObject({ tipo: 'plan', estado: 'completed', clienteId });
    expect(done.output).toMatchObject({ resultado: 'briefs_generados', resumen: { ok: 2, omitidas: 0, fallidas: 0, detenido_por_presupuesto: false } });
    for (const pieza of piezas) {
      expect((await getBriefActual(pool, clienteId, pieza.id))!.version).toBe(1);
      expect((await getPieza(pool, clienteId, pieza.id))!.estado).toBe('guion_listo');
    }
    expect(provider.calls).toHaveLength(2);
    // Finished: no longer "active", so a piece job is not blocked by it.
    expect(await queue.findActivePlanJob(clienteId, plan.id)).toBeNull();

    // The same plan again: every piece already has its brief, nothing is paid.
    const again = await queue.enqueuePlan({ clienteId, planId: plan.id });
    expect(again).not.toBeNull();
    const second = await finished(again!);
    expect(second.output).toMatchObject({ resultado: 'briefs_generados', resumen: { ok: 0, omitidas: 2, fallidas: 0, detenido_por_presupuesto: false } });
    expect(provider.calls).toHaveLength(2);

    // The piece job regenerates one brief.
    const pieceJob = await queue.enqueuePieza({ clienteId, piezaId: piezas[0]!.id, regenerar: true });
    expect(pieceJob).not.toBeNull();
    const regenerated = await finished(pieceJob!);
    expect(regenerated).toMatchObject({ tipo: 'pieza', estado: 'completed' });
    expect(regenerated.output).toMatchObject({ resultado: 'brief_creado', version: 2 });
    expect(provider.calls).toHaveLength(3);
  }, 90_000);
});
