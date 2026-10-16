import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createCliente, createMedia } from '../../tests/utils/factories/index.js';
import type { Db } from '../db/types.js';
import { FakeAlertSink } from '../lib/ai/alerts.js';
import { findClienteByNombreComercial } from '../modules/clientes/clientesRepository.js';
import { listBriefVersions } from '../modules/directorCreativo/index.js';
import { createLlmRuntime } from '../modules/desarrollo/developmentProvider.js';
import { getValidHechos } from '../modules/hechos/hechosRepository.js';
import { listPiezas } from '../modules/piezas/index.js';
import { generarPlanSemanal, addDays, localDateOf, mondayOf } from '../modules/planificador/index.js';
import { asClienteId } from '../modules/shared/clienteId.js';
import { parseBriefGenerateArgs } from './briefGenerateArgs.js';
import { runBriefGenerate } from './briefGenerateCore.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';
import { runPlanApproveInternal } from './planApproveInternalCore.js';
import { parsePlanApproveInternalArgs } from './planApproveInternalArgs.js';
import { SEED_CLIENT_NAME, seedDevelopment } from './seedDevelopment.js';

const SISTEMA = { tipo: 'sistema' } as const;
const ID = '123e4567-e89b-42d3-a456-426614174000';
const ID2 = '223e4567-e89b-42d3-a456-426614174001';
const ZONE = 'America/New_York';
const nextMonday = () => addDays(mondayOf(localDateOf(new Date(), ZONE)), 7);

describe('parseBriefGenerateArgs', () => {
  it('accepts a plan run and a piece run, in both syntaxes', () => {
    expect(parseBriefGenerateArgs(['--cliente', ID, '--plan', ID2])).toEqual({ modo: 'plan', clienteId: ID, planId: ID2 });
    expect(parseBriefGenerateArgs([`--cliente=${ID}`, `--pieza=${ID2}`])).toEqual({ modo: 'pieza', clienteId: ID, piezaId: ID2, regenerar: false });
    expect(parseBriefGenerateArgs(['--cliente', ID, '--pieza', ID2, '--regenerar'])).toMatchObject({ modo: 'pieza', regenerar: true });
  });

  it('rejects bad input without echoing values', () => {
    const bad = [
      [],
      ['--cliente', ID],
      ['--cliente', ID, '--plan', ID2, '--pieza', ID2],
      ['--cliente', ID, '--plan', ID2, '--regenerar'],
      ['--cliente', ID, '--pieza', ID2, '--regenerar=si'],
      ['--cliente', ID, '--pieza', ID2, '--regenerar', '--regenerar'],
      ['--cliente', ID, '--plan', 'secret-not-a-uuid'],
      ['--cliente', 'secret-not-a-uuid', '--plan', ID2],
      ['--cliente', ID, '--plan'],
      ['--cliente', ID, '--cliente', ID, '--plan', ID2],
      ['--force', 'x'],
      ['positional'],
    ];
    for (const argv of bad) {
      let message = '';
      try {
        parseBriefGenerateArgs(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(argv)).not.toBe('');
      expect(message).not.toContain('secret');
    }
  });
});

describe('parsePlanApproveInternalArgs', () => {
  it('accepts --cliente and --plan, and rejects anything else without echoing values', () => {
    expect(parsePlanApproveInternalArgs(['--cliente', ID, '--plan', ID2])).toEqual({ clienteId: ID, planId: ID2 });
    expect(parsePlanApproveInternalArgs([`--cliente=${ID}`, `--plan=${ID2}`])).toEqual({ clienteId: ID, planId: ID2 });
    for (const argv of [[], ['--cliente', ID], ['--plan', ID2], ['--cliente', ID, '--plan', 'secret-x'], ['--cliente', 'secret-x', '--plan', ID2], ['--cliente', ID, '--plan', ID2, '--pieza', ID2], ['--cliente', ID, '--plan', ID2, '--plan', ID2], ['x']]) {
      let message = '';
      try {
        parsePlanApproveInternalArgs(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(argv)).not.toBe('');
      expect(message).not.toContain('secret');
    }
  });
});

describe('the shared development-script guard', () => {
  const url = (name: string) => `postgresql://fakeuser:fakepassword@localhost:5432/${name}`;

  it('accepts a development database and names the script in each refusal, never the URL', async () => {
    for (const script of ['plan:generate', 'plan:approve-internal', 'brief:generate']) {
      expect(assertDevScriptAllowed(script, { nodeEnv: 'development', databaseUrl: url('fake_dev') })).toBe('fake_dev');
      for (const params of [
        { nodeEnv: 'production', databaseUrl: url('fake_dev') },
        { nodeEnv: 'development', databaseUrl: url('fake_test') },
        { nodeEnv: 'development', databaseUrl: url('fake%5Ftest') },
        { nodeEnv: 'development', databaseUrl: 'not a url fakepassword' },
        { nodeEnv: 'development', databaseUrl: 'postgresql://fakeuser:fakepassword@localhost:5432/' },
      ]) {
        let message = '';
        try {
          assertDevScriptAllowed(script, params);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain(`${script} refused`);
        expect(message).not.toContain('fakepassword');
      }
      await expect(confirmDevScriptDatabase(script, { query: async () => ({ rows: [{ name: 'x_test' }] }) as never })).rejects.toThrow(new RegExp(`${script} refused`));
      await expect(confirmDevScriptDatabase(script, { query: async () => ({ rows: [{ name: 'novaciel_dev' }] }) as never })).resolves.toBe('novaciel_dev');
    }
  });
});

interface World {
  db: Db;
  clienteId: ReturnType<typeof asClienteId>;
  runtime: ReturnType<typeof createLlmRuntime>;
  alerts: FakeAlertSink;
  deps: { db: Db; provider: ReturnType<typeof createLlmRuntime>['provider']; alerts: FakeAlertSink; withContext: NonNullable<ReturnType<typeof createLlmRuntime>['withBriefContext']> };
}

async function world(db: Db): Promise<World> {
  await seedDevelopment(db);
  const clienteId = asClienteId((await findClienteByNombreComercial(db, SEED_CLIENT_NAME))!.id);
  const runtime = createLlmRuntime({ provider: 'fake', model: 'fake-model', timeoutMs: 60_000 }, 'development');
  const alerts = new FakeAlertSink();
  return { db, clienteId, runtime, alerts, deps: { db, provider: runtime.provider, alerts, withContext: runtime.withBriefContext! } };
}

/** The whole development flow on the seed client: plan (dev provider), internal approval. */
async function approvedPlan(w: World) {
  const plan = await generarPlanSemanal(
    { db: w.db, provider: w.runtime.provider, alerts: w.alerts, withContext: w.runtime.withPlannerContext! },
    w.clienteId,
    { semana: nextMonday() },
    SISTEMA,
  );
  const approval = await runPlanApproveInternal(w.db, { clienteId: w.clienteId, planId: plan.plan.id });
  expect(approval.ok, approval.lines.join('\n')).toBe(true);
  return { plan: plan.plan, piezas: plan.piezas, approval };
}

const ledger = async (db: Db, clienteId: string, purpose: string) =>
  (await db.query(`SELECT 1 FROM libro_gastos WHERE cliente_id = $1 AND proposito = $2`, [clienteId, purpose], )).rows.length;

describe('plan:approve-internal (core)', () => {
  it('approves the plan and reports only ids and counts', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const { plan, piezas, approval } = await approvedPlan(w);
      const text = approval.lines.join('\n');
      expect(text).toContain(plan.id);
      expect(text).toContain('TEMPORARY until Step 9');
      expect(text).toContain(`${piezas.length} piece(s) moved to plan_aprobado`);
      for (const p of piezas) {
        expect(text).toContain(p.id);
        expect(text).not.toContain(p.idea);
      }
      expect((await listPiezas(db, w.clienteId, { planId: plan.id })).every((p) => p.estado === 'plan_aprobado')).toBe(true);
    });
  });

  it('refuses each bad case with one content-free line', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const { plan } = await approvedPlan(w);
      const again = await runPlanApproveInternal(db, { clienteId: w.clienteId, planId: plan.id });
      expect(again.ok).toBe(false);
      expect(again.lines).toEqual(['Only a draft plan can be approved (state aprobado)']);
      const stranger = asClienteId((await createCliente(db)).id);
      expect((await runPlanApproveInternal(db, { clienteId: stranger, planId: plan.id })).lines).toEqual(['That plan does not exist for this client']);
      expect((await runPlanApproveInternal(db, { clienteId: w.clienteId, planId: ID })).lines).toEqual(['That plan does not exist for this client']);
    });
  });
});

describe('brief:generate (core), with the development provider', () => {
  it('generates the briefs of the whole plan from the seed client, reports counts and never the copy', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      for (let i = 0; i < 3; i++) await createMedia(db, { clienteId: w.clienteId, tipo: 'foto', etiquetas: ['cafe'] });
      const { plan, piezas } = await approvedPlan(w);

      const result = await runBriefGenerate(w.deps, { modo: 'plan', clienteId: w.clienteId, planId: plan.id });
      expect(result.ok, result.lines.join('\n')).toBe(true);
      const text = result.lines.join('\n');
      expect(text).toContain(`Plan ${plan.id}: ${piezas.length} piece(s)`);
      expect(text).toMatch(/generated 3, failed 0; total cost: USD /);
      for (const p of piezas) expect(text).toContain(p.id);
      expect(text).toMatch(/slots \d+ \(with media \d+, missing \d+\), facts: /);

      // Every piece moved on, one ledger row per model call, and the alert sink stayed quiet.
      const after = await listPiezas(db, w.clienteId, { planId: plan.id });
      expect(after.every((p) => p.estado === 'guion_listo')).toBe(true);
      expect(await ledger(db, w.clienteId, 'brief_creativo')).toBe(3);
      expect(w.alerts.alerts).toEqual([]);

      // The report holds none of the copy, ideas or fact texts.
      const valid = await getValidHechos(db, w.clienteId);
      for (const pieza of piezas) {
        for (const version of await listBriefVersions(db, w.clienteId, pieza.id)) {
          expect(text).not.toContain(version.contenido.gancho);
          expect(text).not.toContain(version.contenido.texto_publicacion.texto);
          for (const escena of version.contenido.escenas) expect(text).not.toContain(escena.texto_en_pantalla);
        }
        expect(text).not.toContain(pieza.idea);
      }
      for (const h of valid) expect(text).not.toContain(h.enunciado);
      expect(text).not.toContain('Cafetería Aurora');
    });
  });

  it('uses the photos of the library for the image slots and marks the rest as missing', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const photos = [];
      for (let i = 0; i < 2; i++) photos.push(await createMedia(db, { clienteId: w.clienteId, tipo: 'foto' }));
      const { plan, piezas } = await approvedPlan(w);
      await runBriefGenerate(w.deps, { modo: 'plan', clienteId: w.clienteId, planId: plan.id });
      const carousel = piezas.find((p) => p.formato === 'carrusel');
      expect(carousel, 'the dev planner makes a carousel in a 3-piece week').toBeDefined();
      const [brief] = await listBriefVersions(db, w.clienteId, carousel!.id);
      const real = brief!.tomas.filter((t) => t.fuente === 'media_real').map((t) => t.media_id);
      expect(real.sort()).toEqual(photos.map((m) => m.id).sort());
      expect(brief!.tomas.filter((t) => t.fuente === 'faltante')).toHaveLength(3);
    });
  });

  it('cites the facts of a piece through tokens, stored rendered', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const { plan, piezas } = await approvedPlan(w);
      const withFacts = piezas.find((p) => p.hecho_ids.length > 0);
      await runBriefGenerate(w.deps, { modo: 'plan', clienteId: w.clienteId, planId: plan.id });
      if (withFacts) {
        const [brief] = await listBriefVersions(db, w.clienteId, withFacts.id, { includeModel: true });
        expect(brief!.hecho_ids.sort()).toEqual(withFacts.hecho_ids.sort());
        expect(JSON.stringify(brief!.contenido)).not.toContain('{{hecho:');
        expect(JSON.stringify(brief!.contenido_modelo)).toContain('{{hecho:');
      }
    });
  });

  it('a second plan run without --regenerar is refused: nothing to do', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const { plan } = await approvedPlan(w);
      expect((await runBriefGenerate(w.deps, { modo: 'plan', clienteId: w.clienteId, planId: plan.id })).ok).toBe(true);
      const calls = await ledger(db, w.clienteId, 'brief_creativo');
      const again = await runBriefGenerate(w.deps, { modo: 'plan', clienteId: w.clienteId, planId: plan.id });
      expect(again.ok).toBe(false);
      expect(again.lines.join('\n')).toMatch(/skipped: ya_tiene_guion/);
      expect(again.lines.join('\n')).toMatch(/Nothing to do/);
      expect(await ledger(db, w.clienteId, 'brief_creativo')).toBe(calls); // nothing was paid
    });
  });

  it('a piece run: refused without --regenerar, version 2 with it', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const { plan, piezas } = await approvedPlan(w);
      await runBriefGenerate(w.deps, { modo: 'plan', clienteId: w.clienteId, planId: plan.id });
      const piezaId = piezas[0]!.id;
      const refused = await runBriefGenerate(w.deps, { modo: 'pieza', clienteId: w.clienteId, piezaId, regenerar: false });
      expect(refused.ok).toBe(false);
      expect(refused.lines).toEqual(['The piece already has a current brief (version 1). Use --regenerar to make a new version.']);
      const second = await runBriefGenerate(w.deps, { modo: 'pieza', clienteId: w.clienteId, piezaId, regenerar: true });
      expect(second.ok).toBe(true);
      expect(second.lines[0]).toContain('brief version 2');
      expect(second.lines.at(-1)).toMatch(/^cost: USD /);
    });
  });

  it('refuses a plan that is not approved, an unknown plan or piece, and a budget refusal, with one line each', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const draft = await generarPlanSemanal(
        { db, provider: w.runtime.provider, alerts: w.alerts, withContext: w.runtime.withPlannerContext! },
        w.clienteId,
        { semana: nextMonday() },
        SISTEMA,
      );
      const notApproved = await runBriefGenerate(w.deps, { modo: 'plan', clienteId: w.clienteId, planId: draft.plan.id });
      expect(notApproved.lines).toEqual(['The plan is not approved (state borrador); approve it first (npm run plan:approve-internal)']);
      expect((await runBriefGenerate(w.deps, { modo: 'plan', clienteId: w.clienteId, planId: ID })).lines).toEqual(['That plan does not exist for this client']);
      expect((await runBriefGenerate(w.deps, { modo: 'pieza', clienteId: w.clienteId, piezaId: ID, regenerar: false })).lines).toEqual(['That piece does not exist for this client']);

      await runPlanApproveInternal(db, { clienteId: w.clienteId, planId: draft.plan.id });
      await db.query('UPDATE topes SET monto_techo = 0 WHERE cliente_id = $1', [w.clienteId]); // the month's ceiling exists since the plan call
      const budget = await runBriefGenerate(w.deps, { modo: 'pieza', clienteId: w.clienteId, piezaId: draft.piezas[0]!.id, regenerar: false });
      expect(budget.ok).toBe(false);
      expect(budget.lines).toEqual(['Budget refused: techo_superado']);
      const stopped = await runBriefGenerate(w.deps, { modo: 'plan', clienteId: w.clienteId, planId: draft.plan.id });
      expect(stopped.ok).toBe(false);
      expect(stopped.lines.join('\n')).toMatch(/stopped by the budget/);
    });
  });

  it('keeps another client away from the plan and pieces', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const { plan, piezas } = await approvedPlan(w);
      const stranger = asClienteId((await createCliente(db)).id);
      expect((await runBriefGenerate(w.deps, { modo: 'plan', clienteId: stranger, planId: plan.id })).lines).toEqual(['That plan does not exist for this client']);
      expect((await runBriefGenerate(w.deps, { modo: 'pieza', clienteId: stranger, piezaId: piezas[0]!.id, regenerar: false })).lines).toEqual(['That piece does not exist for this client']);
      expect(await ledger(db, w.clienteId, 'brief_creativo')).toBe(0);
    });
  });
});

describe('the seed', () => {
  it('generates no plan and no brief, also after a second run', async () => {
    await withTestTransaction(async (db) => {
      await seedDevelopment(db);
      await seedDevelopment(db);
      for (const table of ['planes_semanales', 'piezas', 'guiones', 'tomas', 'guiones_hechos']) {
        expect((await db.query(`SELECT 1 FROM ${table}`)).rows, table).toEqual([]);
      }
    });
  });
});
