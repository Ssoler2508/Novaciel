import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createCliente } from '../../tests/utils/factories/index.js';
import type { Db } from '../db/types.js';
import { FakeAlertSink } from '../lib/ai/alerts.js';
import { findClienteByNombreComercial } from '../modules/clientes/clientesRepository.js';
import { DeterministicPlannerFake } from '../modules/planificador/deterministicPlannerFake.js';
import { addDays, localDateOf, mondayOf } from '../modules/planificador/index.js';
import { getCurrentPerfilMarca } from '../modules/perfilMarca/perfilMarcaRepository.js';
import { listPlanes } from '../modules/planificador/index.js';
import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';
import { parsePlanGenerateArgs } from './planGenerateArgs.js';
import { runPlanGenerate } from './planGenerateCore.js';
import { assertPlanGenerateAllowed, confirmPlanGenerateDatabase } from './planGenerateGuard.js';
import { SEED_CLIENT_NAME, seedDevelopment } from './seedDevelopment.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const ZONE = 'America/New_York';
const nextMonday = () => addDays(mondayOf(localDateOf(new Date(), ZONE)), 7);

describe('parsePlanGenerateArgs', () => {
  it('accepts the three options in both syntaxes', () => {
    expect(parsePlanGenerateArgs(['--cliente', ID])).toEqual({ clienteId: ID, reemplazar: false });
    expect(parsePlanGenerateArgs([`--cliente=${ID}`, '--semana=2026-11-02', '--reemplazar'])).toEqual({
      clienteId: ID,
      semana: '2026-11-02',
      reemplazar: true,
    });
  });

  it('rejects bad input without echoing values', () => {
    const bad = [
      [],
      ['--cliente'],
      ['--cliente', '--reemplazar'],
      ['--cliente', ID, '--cliente', ID],
      ['--cliente', ID, '--reemplazar', '--reemplazar'],
      ['--cliente', ID, '--reemplazar=yes'],
      ['--cliente', ID, '--semana', 'secret-not-a-date'],
      ['--cliente', ID, '--semana', '2026-02-30'],
      ['--cliente', 'not-a-uuid-secret-123'],
      ['--force', 'x'],
      ['positional'],
    ];
    for (const argv of bad) {
      let message = '';
      try {
        parsePlanGenerateArgs(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(argv)).not.toBe('');
      expect(message).not.toContain('secret');
    }
  });
});

describe('plan:generate guard', () => {
  const url = (name: string) => `postgresql://fakeuser:fakepassword@localhost:5432/${name}`;

  it('accepts a development database', () => {
    expect(assertPlanGenerateAllowed({ nodeEnv: 'development', databaseUrl: url('fake_dev') })).toBe('fake_dev');
  });

  it('refuses production and test databases, also percent-encoded, without echoing the URL', () => {
    for (const params of [
      { nodeEnv: 'production', databaseUrl: url('fake_dev') },
      { nodeEnv: 'development', databaseUrl: url('fake_test') },
      { nodeEnv: 'development', databaseUrl: url('fake%5Ftest') },
      { nodeEnv: 'development', databaseUrl: 'not a url fakepassword' },
      { nodeEnv: 'development', databaseUrl: 'postgresql://fakeuser:fakepassword@localhost:5432/' },
    ]) {
      let message = '';
      try {
        assertPlanGenerateAllowed(params);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/plan:generate refused/);
      expect(message).not.toContain('fakepassword');
    }
  });

  it('checks the server database name once connected', async () => {
    await expect(confirmPlanGenerateDatabase({ query: async () => ({ rows: [{ name: 'x_test' }] }) as never })).rejects.toThrow(/test database/);
    await expect(confirmPlanGenerateDatabase({ query: async () => ({ rows: [{ name: 'novaciel_dev' }] }) as never })).resolves.toBe('novaciel_dev');
  });
});

interface World {
  db: Db;
  clienteId: ClienteId;
  deps: { db: Db; provider: DeterministicPlannerFake; alerts: FakeAlertSink; withContext: DeterministicPlannerFake['withContext'] };
}

async function world(db: Db): Promise<World> {
  await seedDevelopment(db);
  const clienteId = asClienteId((await findClienteByNombreComercial(db, SEED_CLIENT_NAME))!.id);
  const provider = new DeterministicPlannerFake();
  return { db, clienteId, deps: { db, provider, alerts: new FakeAlertSink(), withContext: (c, run) => provider.withContext(c, run) } };
}

describe('seed and the planner', () => {
  it('gives the seed client a zone and weighted pillars, and generates no plan, even on a second run', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      await seedDevelopment(db);
      const row = (await getCurrentPerfilMarca(db, w.clienteId))! as unknown as {
        operacion: { zona_horaria: string };
        pilares: { temas: { peso: number }[] };
      };
      expect(row.operacion.zona_horaria).toBe(ZONE);
      expect(row.pilares.temas.length).toBeGreaterThanOrEqual(3);
      expect(row.pilares.temas.every((t) => t.peso > 0)).toBe(true);
      expect((await db.query('SELECT 1 FROM planes_semanales')).rows).toEqual([]);
      expect((await db.query('SELECT 1 FROM piezas')).rows).toEqual([]);
    });
  });
});

describe('runPlanGenerate with the deterministic fake', () => {
  it('creates a plan, stores its pieces and one ledger row, and reports without any content', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const result = await runPlanGenerate(w.deps, { clienteId: w.clienteId, reemplazar: false });
      expect(result.ok, result.lines.join('\n')).toBe(true);
      const text = result.lines.join('\n');

      const [plan] = await listPlanes(db, w.clienteId);
      expect(plan!.semana_inicio).toBe(nextMonday());
      expect(text).toContain(plan!.id);
      expect(text).toMatch(/by network: instagram 3/);
      expect(text).toMatch(/by format: /);
      expect(text).toMatch(/by pillar: /);
      expect(text).toMatch(/^ {2}1\. \d{4}-\d{2}-\d{2} \d{2}:\d{2} instagram /m);
      expect(text).toMatch(/cost: USD /);

      const piezas = (await db.query('SELECT idea, fecha_hora FROM piezas WHERE cliente_id = $1', [w.clienteId])).rows as { idea: string }[];
      expect(piezas).toHaveLength(3);
      for (const p of piezas) expect(text).not.toContain(p.idea);
      expect(text).not.toContain(SEED_CLIENT_NAME);

      const ledger = (await db.query(`SELECT costo_real::text AS costo FROM libro_gastos WHERE cliente_id = $1 AND proposito = 'plan_semanal'`, [w.clienteId])).rows as { costo: string }[];
      expect(ledger).toHaveLength(1);
      expect(Number(ledger[0]!.costo)).toBeGreaterThan(0);
    });
  });

  it('honours --semana, normalizing any date of the week to its Monday', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const semana = addDays(nextMonday(), 9);
      const result = await runPlanGenerate(w.deps, { clienteId: w.clienteId, semana, reemplazar: false });
      expect(result.ok).toBe(true);
      expect((await listPlanes(db, w.clienteId))[0]!.semana_inicio).toBe(mondayOf(semana));
    });
  });

  it('refuses a second run without --reemplazar, with the hint, and replaces the draft with it', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const args = { clienteId: w.clienteId, reemplazar: false };
      expect((await runPlanGenerate(w.deps, args)).ok).toBe(true);
      const second = await runPlanGenerate(w.deps, args);
      expect(second.ok).toBe(false);
      expect(second.lines).toHaveLength(1);
      expect(second.lines[0]).toMatch(/already has a borrador plan/);
      expect(second.lines[0]).toMatch(/--reemplazar/);

      const third = await runPlanGenerate(w.deps, { ...args, reemplazar: true });
      expect(third.ok, third.lines.join('\n')).toBe(true);
      const plans = await listPlanes(db, w.clienteId);
      expect(plans.filter((p) => p.estado === 'borrador')).toHaveLength(1);
    });
  });

  it('names the incomplete blocks and fields, nothing else, for a client without a profile', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const other = await createCliente(db);
      const result = await runPlanGenerate(w.deps, { clienteId: asClienteId(other.id), reemplazar: false });
      expect(result.ok).toBe(false);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toMatch(/^Cannot plan yet\. Incomplete: /);
    });
  });

  it('reports a budget refusal on one line', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const unpriced = new DeterministicPlannerFake({ defaultModel: 'model-without-price' });
      const result = await runPlanGenerate(
        { ...w.deps, provider: unpriced, withContext: (c, run) => unpriced.withContext(c, run) },
        { clienteId: w.clienteId, reemplazar: false },
      );
      expect(result.ok).toBe(false);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toMatch(/No price for the model|Budget refused/);
    });
  });

  it('uses next week by default relative to the given clock', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const now = new Date('2026-06-10T15:00:00Z'); // a Wednesday
      const result = await runPlanGenerate(w.deps, { clienteId: w.clienteId, reemplazar: false }, now);
      expect(result.ok, result.lines.join('\n')).toBe(true);
      expect((await listPlanes(db, w.clienteId))[0]!.semana_inicio).toBe('2026-06-15');
    });
  });
});
