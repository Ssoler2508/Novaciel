import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import {
  createAutorizacionImagen,
  createCliente,
  createConfiguracionGastoCliente,
  createHechoVerificado,
  createPerfilMarca,
  createPrecioModelo,
  createReglaProhibida,
  createUsuario,
} from '../../../tests/utils/factories/index.js';
import { SEED_IDIOMA, SEED_PROFILE } from '../../scripts/seedProfile.js';
import { FakeAlertSink } from '../../lib/ai/alerts.js';
import { FakeLLMProvider } from '../../lib/ai/fakeLLMProvider.js';
import { LLMProviderError } from '../../lib/ai/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { seedDevelopment, SEED_CLIENT_NAME } from '../../scripts/seedDevelopment.js';
import { findClienteByNombreComercial } from '../clientes/clientesRepository.js';
import { getValidHechos } from '../hechos/hechosRepository.js';
import { asClienteId } from '../shared/clienteId.js';
import { addDays, localDateOf, mondayOf } from './fechas.js';
import {
  createPgBossPlanQueue,
  ejecutarJobGenerarPlan,
  GENERAR_PLAN_QUEUE,
  registerPlanificadorJobs,
  singletonKeyFor,
} from './planificadorJobs.js';
import { listPlanes } from './planesRepository.js';

const ZONE = 'America/New_York';
const nextMonday = () => addDays(mondayOf(localDateOf(new Date(), ZONE)), 7);
const SECRET_IDEA = 'IDEA-PRIVADA-DEL-PLAN-5521';

function planJson(semana: string, cifraId: string, idea = SECRET_IDEA): string {
  return JSON.stringify({
    piezas: [
      { red: 'instagram', formato: 'reel', pilar: 'Origen del café', trabajo: 'atraer', fecha: addDays(semana, 1), hora: '10:00', idea, hecho_ids: [cifraId] },
      { red: 'instagram', formato: 'carrusel', pilar: 'Repostería artesanal', trabajo: 'confianza', fecha: addDays(semana, 3), hora: '12:30', idea: 'Cómo se hornea nuestra torta', hecho_ids: [] },
      { red: 'instagram', formato: 'historia', pilar: 'Vida del barrio', trabajo: 'accion', fecha: addDays(semana, 4), hora: '16:00', idea: 'Pásate hoy por tu café con calma', hecho_ids: [] },
    ],
  });
}

describe('ejecutarJobGenerarPlan', () => {
  async function setup(db: Parameters<Parameters<typeof withTestTransaction>[0]>[0]) {
    await seedDevelopment(db);
    const clienteId = asClienteId((await findClienteByNombreComercial(db, SEED_CLIENT_NAME))!.id);
    const cifra = (await getValidHechos(db, clienteId)).find((h) => h.tipo === 'cifra')!.id;
    const lines: string[] = [];
    const logger = createLogger('debug', { write: (l: string) => void lines.push(l) });
    const provider = new FakeLLMProvider();
    return { clienteId, cifra, provider, lines, deps: { db, provider, alerts: new FakeAlertSink(), logger } };
  }

  it('creates the plan as the system and returns a content-free output with the plan id', async () => {
    await withTestTransaction(async (db) => {
      const s = await setup(db);
      s.provider.enqueue(planJson(nextMonday(), s.cifra));
      const output = await ejecutarJobGenerarPlan(s.deps, { clienteId: s.clienteId, semana: nextMonday() }, 'job-1');
      expect(output).toEqual({ resultado: 'plan_creado', plan_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      const plans = await listPlanes(db, s.clienteId);
      expect(plans.map((p) => p.id)).toEqual([output.plan_id]);
      expect(plans[0]).toMatchObject({ creado_por: null, estado: 'borrador' });
      const audit = await db.query(`SELECT actor_tipo FROM auditoria WHERE tabla = 'planes_semanales' AND fila_id = $1`, [output.plan_id]);
      expect(audit.rows).toEqual([{ actor_tipo: 'sistema' }]);
    });
  });

  it('turns each expected domain error into a "rechazado" output with the error name', async () => {
    await withTestTransaction(async (db) => {
      const s = await setup(db);
      const semana = nextMonday();
      const run = (data: unknown = { clienteId: s.clienteId, semana }) => ejecutarJobGenerarPlan(s.deps, data);

      // Existing plan for the week.
      s.provider.enqueue(planJson(semana, s.cifra));
      await run();
      expect(await run()).toEqual({ resultado: 'rechazado', codigo: 'PlanExistenteError' });
      // Invalid model output twice.
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE cliente_id = $1`, [s.clienteId]);
      s.provider.enqueue('basura', 'más basura');
      expect(await run()).toEqual({ resultado: 'rechazado', codigo: 'SchemaValidationError' });
      // Refused budget.
      await db.query('UPDATE configuracion_gasto_cliente SET gasto_habilitado = false WHERE cliente_id = $1', [s.clienteId]);
      expect(await run()).toEqual({ resultado: 'rechazado', codigo: 'BudgetRefusedError' });
      // A client that cannot be planned.
      const { rows } = await db.query<{ id: string }>(`INSERT INTO clientes (nombre_comercial) VALUES ('Cliente sin perfil ficticio') RETURNING id`);
      expect(await run({ clienteId: rows[0]!.id, semana })).toEqual({ resultado: 'rechazado', codigo: 'NoPuedePlanificarError' });
      // A payload that is not valid.
      for (const bad of [null, {}, { clienteId: 'x', semana }, { clienteId: s.clienteId, semana: '2026-02-30' }, { clienteId: s.clienteId, semana, extra: 1 }]) {
        expect(await run(bad)).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
      }
    });
  });

  it('lets an unexpected error fail the job instead of hiding it', async () => {
    await withTestTransaction(async (db) => {
      const s = await setup(db);
      const failure = new LLMProviderError('upstream unavailable');
      s.provider.enqueue({ error: failure });
      await expect(ejecutarJobGenerarPlan(s.deps, { clienteId: s.clienteId, semana: nextMonday() })).rejects.toBe(failure);
      expect(await listPlanes(db, s.clienteId)).toEqual([]);
    });
  });

  it('logs ids, counts and error names only', async () => {
    await withTestTransaction(async (db) => {
      const s = await setup(db);
      s.provider.enqueue(planJson(nextMonday(), s.cifra));
      await ejecutarJobGenerarPlan(s.deps, { clienteId: s.clienteId, semana: nextMonday() }, 'job-9');
      await ejecutarJobGenerarPlan(s.deps, { clienteId: s.clienteId, semana: nextMonday() }, 'job-10');
      const logs = s.lines.join('');
      expect(logs).toContain('weekly plan job done');
      expect(logs).toContain('weekly plan job rejected');
      expect(logs).toContain('PlanExistenteError');
      for (const hidden of [SECRET_IDEA, 'Cafetería Aurora', 'Reply with JSON only', 'EXTERNAL_DATA']) expect(logs, hidden).not.toContain(hidden);
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

describe('the singleton key, with the real pg-boss', () => {
  const SCHEMA = 'pgboss_planner_singleton_test';
  const boss = newBoss(SCHEMA);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await dropSchema(SCHEMA);
  });

  it('allows one queued generation per client and week, and different keys in parallel', async () => {
    await boss.start();
    // The queue only, with no worker: the jobs stay queued so the policy can be observed.
    await boss.createQueue(GENERAR_PLAN_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
    const queue = createPgBossPlanQueue(boss);
    const clienteA = '11111111-1111-4111-8111-111111111111';
    const clienteB = '22222222-2222-4222-8222-222222222222';
    const semana = '2026-11-02';

    const first = await queue.enqueue({ clienteId: clienteA, semana });
    expect(first).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(await queue.enqueue({ clienteId: clienteA, semana })).toBeNull(); // the same week, in parallel
    expect(await queue.enqueue({ clienteId: clienteA, semana, reemplazar: true })).toBeNull();
    const otherWeek = await queue.enqueue({ clienteId: clienteA, semana: '2026-11-09' });
    const otherClient = await queue.enqueue({ clienteId: clienteB, semana });
    expect(otherWeek).not.toBeNull();
    expect(otherClient).not.toBeNull();

    expect(singletonKeyFor(clienteA, semana)).toBe(`${clienteA}:${semana}`);
    expect(await queue.getJob(first!)).toEqual({ estado: 'created', clienteId: clienteA, output: null });
    expect(await queue.getJob('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('the worker, with the real pg-boss', () => {
  const SCHEMA = 'pgboss_planner_worker_test';
  const boss = newBoss(SCHEMA);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await dropSchema(SCHEMA);
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  async function finished(jobId: string) {
    const queue = createPgBossPlanQueue(boss);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const job = await queue.getJob(jobId);
      if (job && (job.estado === 'completed' || job.estado === 'failed')) return job;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('the job did not finish in time');
  }

  it('runs the job, stores the plan, and a second run for the same week is rejected with the error name', async () => {
    const pool = getTestPool();
    await cleanupDomainTables(pool);
    // Committed data: the worker uses its own connections. It is built with the test factories (plain
    // SQL, no audit rows), NOT with the seed: the audit log is append-only and its rows would stay in
    // the test database for good, which other tests (counting audit rows per table) do not expect.
    const user = await createUsuario(pool);
    const cliente = await createCliente(pool);
    const clienteId = asClienteId(cliente.id);
    await createPerfilMarca(pool, { clienteId, creadoPor: user.id, idiomaContenido: SEED_IDIOMA, ...SEED_PROFILE });
    await createHechoVerificado(pool, { clienteId, verificadoPor: user.id, tipo: 'precio', enunciado: 'Precio ficticio.' });
    await createHechoVerificado(pool, { clienteId, verificadoPor: user.id, tipo: 'horario', enunciado: 'Horario ficticio.' });
    const cifra = (await createHechoVerificado(pool, { clienteId, verificadoPor: user.id, tipo: 'cifra', enunciado: 'Cifra ficticia.' })).id;
    await createReglaProhibida(pool, { clienteId, tipo: 'palabra', texto: 'garantizado' });
    await createAutorizacionImagen(pool, { clienteId });
    await createPrecioModelo(pool, { proveedor: 'fake', modelo: 'fake-model', precioEntrada: '1', precioSalida: '2' });
    await createConfiguracionGastoCliente(pool, { clienteId, techoMensualDefecto: '1' });
    const semana = nextMonday();
    const provider = new FakeLLMProvider().enqueue(planJson(semana, cifra));

    await boss.start();
    await registerPlanificadorJobs(boss, { db: pool, provider, alerts: new FakeAlertSink() });
    const queue = createPgBossPlanQueue(boss);

    const jobId = await queue.enqueue({ clienteId, semana });
    expect(jobId).not.toBeNull();
    const done = await finished(jobId!);
    expect(done).toMatchObject({ estado: 'completed', clienteId });
    expect(done.output).toMatchObject({ resultado: 'plan_creado', plan_id: expect.any(String) });
    const plans = await listPlanes(pool, clienteId);
    expect(plans.map((p) => p.id)).toEqual([(done.output as { plan_id: string }).plan_id]);
    expect(provider.calls).toHaveLength(1);

    // Once the first job is finished, the same week can be queued again, and the worker rejects it
    // (the week has a plan) without calling the model.
    const again = await queue.enqueue({ clienteId, semana });
    expect(again).not.toBeNull();
    const rejected = await finished(again!);
    expect(rejected.estado).toBe('completed');
    expect(rejected.output).toEqual({ resultado: 'rechazado', codigo: 'PlanExistenteError' });
    expect(provider.calls).toHaveLength(1);
  }, 90_000);
});
