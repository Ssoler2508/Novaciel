import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import {
  createCliente,
  createHechoVerificado,
  createPieza,
  createPlanSemanal,
  createUsuario,
  insertHistorial,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeAlertSink } from '../../lib/ai/alerts.js';
import { FakeLLMProvider } from '../../lib/ai/fakeLLMProvider.js';
import type { LLMRequest, LLMResponse } from '../../lib/ai/types.js';
import { LLMProviderError } from '../../lib/ai/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { SchemaValidationError } from '../ai/generateStructured.js';
import { findClienteByNombreComercial } from '../clientes/clientesRepository.js';
import { getValidHechos } from '../hechos/hechosRepository.js';
import { createNewVersion, getCurrentPerfilMarca } from '../perfilMarca/perfilMarcaRepository.js';
import { getHistorial, getPieza, listPiezas, PlanDescartadoError, pausarPieza, reanudarPieza, transitionPieza } from '../piezas/index.js';
import { microToUsd } from '../presupuesto/money.js';
import { BudgetRefusedError } from '../presupuesto/presupuestoService.js';
import { getUsuarioByEmail } from '../usuarios/usuariosRepository.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { seedDevelopment, SEED_CLIENT_NAME, SEED_OWNER_EMAIL } from '../../scripts/seedDevelopment.js';
import {
  generarPlanSemanal,
  getPlan,
  getPlanActivoDeSemana,
  HechoVencidoError,
  listPlanes,
  NoPuedePlanificarError,
  PlanExistenteError,
  toUtc,
  addDays,
  localDateOf,
  mondayOf,
} from './index.js';

const SISTEMA = { tipo: 'sistema' } as const;
const ZONE = 'America/New_York';
const IDEA_1 = 'Un vistazo al origen de nuestros granos';
const IDEA_2 = 'Cómo se hornea nuestra torta de zanahoria';
const IDEA_3 = 'Pásate hoy por tu café con calma';

/** Monday of next week in New York, from the real clock, so the tests do not age. */
const nextMonday = () => addDays(mondayOf(localDateOf(new Date(), ZONE)), 7);

interface World {
  db: Db;
  clienteId: ClienteId;
  semana: string;
  provider: FakeLLMProvider;
  alerts: FakeAlertSink;
  logs: string[];
  facts: { precio: string; horario: string; cifra: string };
  deps: { db: Db; provider: FakeLLMProvider; alerts: FakeAlertSink; logger: ReturnType<typeof createLogger> };
}

async function world(db: Db, provider = new FakeLLMProvider()): Promise<World> {
  await seedDevelopment(db);
  const clienteId = asClienteId((await findClienteByNombreComercial(db, SEED_CLIENT_NAME))!.id);
  const valid = await getValidHechos(db, clienteId);
  const byTipo = (tipo: string) => valid.find((h) => h.tipo === tipo)!.id;
  const lines: string[] = [];
  const logger = createLogger('debug', { write: (l: string) => void lines.push(l) });
  const alerts = new FakeAlertSink();
  return {
    db,
    clienteId,
    semana: nextMonday(),
    provider,
    alerts,
    logs: lines,
    facts: { precio: byTipo('precio'), horario: byTipo('horario'), cifra: byTipo('cifra') },
    deps: { db, provider, alerts, logger },
  };
}

/** A valid 3-piece plan for the seed client, in the week starting at `semana`. */
function planJson(w: Pick<World, 'semana' | 'facts'>, overrides: { hechos?: string[][]; semana?: string } = {}): string {
  const semana = overrides.semana ?? w.semana;
  const [h1, h2, h3] = overrides.hechos ?? [[w.facts.cifra], [w.facts.precio], [w.facts.horario]];
  return JSON.stringify({
    piezas: [
      { red: 'instagram', formato: 'reel', pilar: 'Origen del café', trabajo: 'atraer', fecha: addDays(semana, 1), hora: '10:00', idea: IDEA_1, hecho_ids: h1 },
      { red: 'instagram', formato: 'carrusel', pilar: 'Repostería artesanal', trabajo: 'confianza', fecha: addDays(semana, 3), hora: '12:30', idea: IDEA_2, hecho_ids: h2 },
      { red: 'instagram', formato: 'historia', pilar: 'Vida del barrio', trabajo: 'accion', fecha: addDays(semana, 4), hora: '16:00', idea: IDEA_3, hecho_ids: h3 },
    ],
  });
}

const ledger = async (db: Db, clienteId: string) =>
  (await db.query(`SELECT resultado, proposito, costo_real::text AS costo FROM libro_gastos WHERE cliente_id = $1 ORDER BY id`, [clienteId])).rows;
const countRows = async (db: Db, table: string, clienteId: string) =>
  Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE cliente_id = $1`, [clienteId])).rows[0].n);

describe('generarPlanSemanal: the plan is stored', () => {
  it('stores a draft plan with its pieces, UTC times, fact links, history, audit and one ledger row', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(planJson(w));
      const result = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);

      expect(result.plan).toMatchObject({ cliente_id: w.clienteId, semana_inicio: w.semana, zona_horaria: ZONE, estado: 'borrador', creado_por: null });
      const perfil = (await getCurrentPerfilMarca(db, w.clienteId))!;
      expect(result.plan.perfil_marca_id).toBe(perfil.id);
      expect(result.piezas).toHaveLength(3);
      expect(result.piezas.every((p) => p.estado === 'planeada' && p.estado_previo === null && p.version_estado === 0)).toBe(true);

      // Local times converted to UTC in the client's zone.
      expect(result.piezas.map((p) => p.fecha_hora.toISOString())).toEqual([
        toUtc(addDays(w.semana, 1), '10:00', ZONE).toISOString(),
        toUtc(addDays(w.semana, 3), '12:30', ZONE).toISOString(),
        toUtc(addDays(w.semana, 4), '16:00', ZONE).toISOString(),
      ]);
      expect(result.piezas.map((p) => p.hecho_ids)).toEqual([[w.facts.cifra], [w.facts.precio], [w.facts.horario]]);
      expect(result.piezas.map((p) => p.idea)).toEqual([IDEA_1, IDEA_2, IDEA_3]);

      // First history row of each piece: creation, version 0.
      for (const pieza of result.piezas) {
        const history = await getHistorial(db, w.clienteId, pieza.id);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ version: 0, desde: null, hacia: 'planeada', actor_tipo: 'sistema' });
      }

      // One ledger row for the model call, and the returned cost matches it.
      const rows = await ledger(db, w.clienteId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ resultado: 'ok', proposito: 'plan_semanal' });
      expect(result.generacion).toMatchObject({ intentos: 1, piezasPorSemana: 3, frecuenciaOrigen: 'defecto' });
      expect(microToUsd(result.generacion.costo)).toBe(rows[0].costo);

      // Audit: one row for the plan and one per piece, without the idea text.
      const planAudit = await auditRowsFor(db, 'planes_semanales', result.plan.id);
      expect(planAudit.map((a) => a.accion)).toEqual(['crear']);
      for (const pieza of result.piezas) {
        const audit = (await auditRowsFor(db, 'piezas', pieza.id)).filter((a) => a.accion === 'crear');
        expect(audit).toHaveLength(1);
        expect(JSON.stringify(audit[0])).not.toMatch(/granos|zanahoria|calma/);
      }
      expect(w.alerts.alerts).toEqual([]);
      expect(w.provider.calls).toHaveLength(1);
    });
  });

  it('reads the frequency from plan.piezas_por_semana and says so', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const owner = (await getUsuarioByEmail(db, SEED_OWNER_EMAIL))!;
      await createNewVersion(db, w.clienteId, { creadoPor: owner.id, plan: { piezas_por_semana: 2 } });
      w.provider.enqueue(JSON.stringify({ piezas: JSON.parse(planJson(w)).piezas.slice(0, 2) }));
      const result = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);
      expect(result.piezas).toHaveLength(2);
      expect(result.generacion).toMatchObject({ piezasPorSemana: 2, frecuenciaOrigen: 'perfil' });
    });
  });

  it('normalizes any date of the week (string or instant) to the Monday in the client zone', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const noFacts = { hechos: [[], [], []] as string[][] };
      for (const semana of [addDays(w.semana, 4), new Date(toUtc(addDays(w.semana, 2), '12:00', ZONE))]) {
        await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE cliente_id = $1`, [w.clienteId]);
        w.provider.enqueue(planJson(w, noFacts));
        const result = await generarPlanSemanal(w.deps, w.clienteId, { semana }, SISTEMA);
        expect(result.plan.semana_inicio).toBe(w.semana);
      }
      // 03:30 UTC on Monday is still Sunday night in New York: that belongs to the PREVIOUS week.
      const sundayNight = new Date(`${w.semana}T03:30:00Z`);
      const previous = addDays(w.semana, -7);
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE cliente_id = $1`, [w.clienteId]);
      w.provider.enqueue(planJson(w, { ...noFacts, semana: previous }));
      expect((await generarPlanSemanal(w.deps, w.clienteId, { semana: sundayNight }, SISTEMA)).plan.semana_inicio).toBe(previous);
    });
  });
});

describe('generarPlanSemanal: refusals before any model call', () => {
  it('an incomplete profile gives NoPuedePlanificarError naming blocks and fields, with 0 calls and nothing spent', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const owner = (await getUsuarioByEmail(db, SEED_OWNER_EMAIL))!;
      const perfil = (await getCurrentPerfilMarca(db, w.clienteId))!;
      const { zona_horaria: _drop, ...operacion } = perfil.operacion as Record<string, unknown>;
      await createNewVersion(db, w.clienteId, { creadoPor: owner.id, operacion });
      w.provider.enqueue(planJson(w));

      const error = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NoPuedePlanificarError);
      const bloques = (error as NoPuedePlanificarError).bloques;
      expect(bloques.find((b) => b.bloque === 'operacion')?.faltan).toContain('zona_horaria');
      expect((error as Error).message).not.toContain('Aurora');
      expect(w.provider.calls).toHaveLength(0);
      expect(await ledger(db, w.clienteId)).toEqual([]);
      expect(await countRows(db, 'planes_semanales', w.clienteId)).toBe(0);
    });
  });

  it('a client without a profile gives NoPuedePlanificarError', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const other = asClienteId((await createCliente(db)).id);
      await expect(generarPlanSemanal(w.deps, other, { semana: w.semana }, SISTEMA)).rejects.toBeInstanceOf(NoPuedePlanificarError);
      expect(w.provider.calls).toHaveLength(0);
    });
  });

  it('an existing plan for the week is refused with no call and nothing spent', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(planJson(w), planJson(w));
      const first = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);
      const error = await generarPlanSemanal(w.deps, w.clienteId, { semana: addDays(w.semana, 2) }, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PlanExistenteError);
      expect(error).toMatchObject({ planId: first.plan.id, estado: 'borrador', reemplazable: true });
      expect(w.provider.calls).toHaveLength(1);
      expect(await ledger(db, w.clienteId)).toHaveLength(1);
    });
  });

  it('a proposed or approved plan is never replaced, even when asked', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(planJson(w), planJson(w));
      const first = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);
      for (const estado of ['propuesto', 'aprobado']) {
        await db.query('UPDATE planes_semanales SET estado = $2 WHERE id = $1', [first.plan.id, estado]);
        const error = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana, reemplazar: true }, SISTEMA).catch((e: unknown) => e);
        expect(error).toMatchObject({ name: 'PlanExistenteError', estado, reemplazable: false });
      }
      expect(w.provider.calls).toHaveLength(1);
    });
  });

  it('a refused budget (ceiling, client switch) means 0 provider calls and no plan', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(planJson(w));
      await db.query('UPDATE configuracion_gasto_cliente SET techo_mensual_defecto = 0 WHERE cliente_id = $1', [w.clienteId]);
      await expect(generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA)).rejects.toMatchObject({ reason: 'techo_superado' });
      await db.query('UPDATE configuracion_gasto_cliente SET techo_mensual_defecto = 1, gasto_habilitado = false WHERE cliente_id = $1', [w.clienteId]);
      await expect(generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA)).rejects.toBeInstanceOf(BudgetRefusedError);
      expect(w.provider.calls).toHaveLength(0);
      expect(await countRows(db, 'planes_semanales', w.clienteId)).toBe(0);
    });
  });
});

describe('generarPlanSemanal: replacing a draft', () => {
  it('discards the old draft (audited), stores the new one, and hides the old pieces', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(planJson(w), planJson(w));
      const old = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);
      const fresh = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana, reemplazar: true }, SISTEMA);

      expect(fresh.plan.id).not.toBe(old.plan.id);
      expect((await getPlan(db, w.clienteId, old.plan.id))!.estado).toBe('descartado');
      expect((await getPlanActivoDeSemana(db, w.clienteId, w.semana))!.id).toBe(fresh.plan.id);
      expect(await listPlanes(db, w.clienteId)).toHaveLength(2);
      const audit = await auditRowsFor(db, 'planes_semanales', old.plan.id);
      expect(audit.map((a) => a.accion)).toEqual(['crear', 'descartar']);
      expect(audit[1]).toMatchObject({ datos_antes: { estado: 'borrador' }, datos_despues: { estado: 'descartado' } });
      expect(await ledger(db, w.clienteId)).toHaveLength(2);

      // The old pieces are dead: hidden by default, visible for audit views, and they cannot change state.
      const live = await listPiezas(db, w.clienteId);
      expect(live.map((p) => p.id).sort()).toEqual(fresh.piezas.map((p) => p.id).sort());
      const all = await listPiezas(db, w.clienteId, { includeDescartados: true });
      expect(all).toHaveLength(6);
      expect(all.filter((p) => p.plan_estado === 'descartado').map((p) => p.id).sort()).toEqual(old.piezas.map((p) => p.id).sort());
      const dead = old.piezas[0]!;
      expect(await listPiezas(db, w.clienteId, { planId: old.plan.id })).toEqual([]);
      expect((await listPiezas(db, w.clienteId, { planId: old.plan.id, includeDescartados: true })).map((p) => p.id)).toContain(dead.id);
      expect(await getPieza(db, w.clienteId, dead.id)).toBeNull();
      expect((await getPieza(db, w.clienteId, dead.id, { includeDescartados: true }))!.plan_estado).toBe('descartado');

      // Service: transition, pause and resume are all refused.
      await expect(transitionPieza(db, w.clienteId, dead.id, 'plan_aprobado', SISTEMA)).rejects.toBeInstanceOf(PlanDescartadoError);
      await expect(pausarPieza(db, w.clienteId, dead.id, SISTEMA)).rejects.toBeInstanceOf(PlanDescartadoError);
      await expect(reanudarPieza(db, w.clienteId, dead.id, SISTEMA)).rejects.toBeInstanceOf(PlanDescartadoError);

      // Raw SQL: the database refuses too, even with a perfectly valid history row.
      await insertHistorial(db, dead.id, w.clienteId, { version: 1, desde: 'planeada', hacia: 'plan_aprobado', actor: SISTEMA });
      await db.query('SAVEPOINT raw');
      await expect(db.query(`UPDATE piezas SET estado = 'plan_aprobado' WHERE id = $1`, [dead.id])).rejects.toThrow(/plan of this piece is discarded/);
      await db.query('ROLLBACK TO SAVEPOINT raw');
      expect((await db.query('SELECT estado FROM piezas WHERE id = $1', [dead.id])).rows[0].estado).toBe('planeada');
      // The live pieces still move.
      await transitionPieza(db, w.clienteId, fresh.piezas[0]!.id, 'plan_aprobado', SISTEMA);
    });
  });

  it('a failed generation does NOT discard the old draft', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(planJson(w), 'no es json', 'tampoco');
      const old = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);
      await expect(generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana, reemplazar: true }, SISTEMA)).rejects.toBeInstanceOf(SchemaValidationError);
      expect((await getPlan(db, w.clienteId, old.plan.id))!.estado).toBe('borrador');
      expect((await listPiezas(db, w.clienteId)).map((p) => p.id).sort()).toEqual(old.piezas.map((p) => p.id).sort());
    });
  });
});

describe('generarPlanSemanal: the model output', () => {
  it('invalid then valid output: two ledger rows and one plan', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue('{"piezas": []}', planJson(w));
      const result = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);
      expect(result.generacion.intentos).toBe(2);
      expect((await ledger(db, w.clienteId)).map((r) => r.resultado)).toEqual(['schema_invalido', 'ok']);
      expect(await countRows(db, 'planes_semanales', w.clienteId)).toBe(1);
      expect(await countRows(db, 'piezas', w.clienteId)).toBe(3);
      expect(w.alerts.alerts).toEqual([]);
    });
  });

  it('semantic mistakes use the same retry: a made-up pillar is rejected and the corrected plan is stored', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const wrong = JSON.parse(planJson(w));
      wrong.piezas[0].pilar = 'Un pilar inventado';
      w.provider.enqueue(JSON.stringify(wrong), planJson(w));
      const result = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);
      expect(result.generacion.intentos).toBe(2);
      expect(result.piezas.map((p) => p.pilar)).toEqual(['Origen del café', 'Repostería artesanal', 'Vida del barrio']);
    });
  });

  it('invalid output twice: one alert, an error, and no plan or pieces', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue('{"nope": true}', 'tampoco');
      await expect(generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA)).rejects.toBeInstanceOf(SchemaValidationError);
      expect(w.alerts.alerts).toHaveLength(1);
      expect(w.alerts.alerts[0]).toMatchObject({ code: 'llm_schema_invalid', purpose: 'plan_semanal', attempts: 2 });
      expect((await ledger(db, w.clienteId)).map((r) => r.resultado)).toEqual(['schema_invalido', 'schema_invalido']);
      expect(await countRows(db, 'planes_semanales', w.clienteId)).toBe(0);
      expect(await countRows(db, 'piezas', w.clienteId)).toBe(0);
    });
  });

  it('a provider error stores nothing and gives the reservation back', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue({ error: new LLMProviderError('upstream unavailable') });
      await expect(generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA)).rejects.toBeInstanceOf(LLMProviderError);
      expect(await countRows(db, 'planes_semanales', w.clienteId)).toBe(0);
      expect(await ledger(db, w.clienteId)).toEqual([]);
      const states = await db.query('SELECT estado FROM autorizaciones_gasto WHERE cliente_id = $1', [w.clienteId]);
      expect(states.rows).toEqual([{ estado: 'liberada' }]);
    });
  });
});

/** A provider that edits the database right after the model answered, to simulate time passing. */
class ProviderWithSideEffect extends FakeLLMProvider {
  constructor(private readonly afterAnswer: () => Promise<void>) {
    super();
  }
  override async generate(request: LLMRequest): Promise<LLMResponse> {
    const response = await super.generate(request);
    await this.afterAnswer();
    return response;
  }
}

describe('generarPlanSemanal: rule 2, re-checked when storing', () => {
  it('a fact that expires between the model call and the write gives no plan', async () => {
    await withTestTransaction(async (db) => {
      let expireFact: () => Promise<void> = async () => undefined;
      const w = await world(db, new ProviderWithSideEffect(() => expireFact()));
      expireFact = async () => {
        await db.query(`UPDATE hechos_verificados SET vigente_desde = now() - interval '2 days', vigente_hasta = now() WHERE id = $1`, [w.facts.cifra]);
      };
      w.provider.enqueue(planJson(w));
      const error = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HechoVencidoError);
      expect((error as HechoVencidoError).hechoIds).toEqual([w.facts.cifra]);
      expect(await countRows(db, 'planes_semanales', w.clienteId)).toBe(0);
      expect(await countRows(db, 'piezas', w.clienteId)).toBe(0);
      expect(await countRows(db, 'piezas_hechos', w.clienteId)).toBe(0);
      expect(await ledger(db, w.clienteId)).toHaveLength(1); // the model call was made and paid
    });
  });

  it('a fact shortened to end before its piece goes out is also refused', async () => {
    await withTestTransaction(async (db) => {
      let edit: () => Promise<void> = async () => undefined;
      const w = await world(db, new ProviderWithSideEffect(() => edit()));
      edit = async () => {
        // Still valid now, but ends before the piece scheduled for Tuesday of next week.
        await db.query(`UPDATE hechos_verificados SET vigente_hasta = now() + interval '1 day' WHERE id = $1`, [w.facts.precio]);
      };
      w.provider.enqueue(planJson(w));
      await expect(generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA)).rejects.toBeInstanceOf(HechoVencidoError);
      expect(await countRows(db, 'planes_semanales', w.clienteId)).toBe(0);
    });
  });

  it('a plan that appears during the model call is respected', async () => {
    await withTestTransaction(async (db) => {
      let race: () => Promise<void> = async () => undefined;
      const w = await world(db, new ProviderWithSideEffect(() => race()));
      race = async () => {
        await createPlanSemanal(db, { clienteId: w.clienteId, semanaInicio: w.semana, estado: 'borrador' });
      };
      w.provider.enqueue(planJson(w));
      const error = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PlanExistenteError);
      expect(await countRows(db, 'piezas', w.clienteId)).toBe(0);
    });
  });
});

describe('generarPlanSemanal: isolation and logs', () => {
  it("never uses another client's data, and A cannot read B's plans", async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const other = asClienteId((await createCliente(db)).id);
      const user = await createUsuario(db);
      const foreignFact = await createHechoVerificado(db, { clienteId: other, verificadoPor: user.id, enunciado: 'HECHO-PRIVADO-DE-OTRO-CLIENTE' });
      const foreignPlan = await createPlanSemanal(db, { clienteId: other, semanaInicio: w.semana });
      await createPieza(db, { clienteId: other, planId: foreignPlan.id });

      // The other client's fact id is not in A's prompt, and citing it fails validation (retry, then alert).
      w.provider.enqueue(planJson(w, { hechos: [[foreignFact.id], [], []] }), planJson(w));
      const result = await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);
      for (const call of w.provider.calls) {
        const text = JSON.stringify(call);
        expect(text).not.toContain('HECHO-PRIVADO-DE-OTRO-CLIENTE');
        expect(text).not.toContain(foreignFact.id);
      }
      expect(result.generacion.intentos).toBe(2);
      expect(result.piezas.flatMap((p) => p.hecho_ids)).not.toContain(foreignFact.id);

      // A's week is its own: B's plan for the same week did not block it, and A cannot read it.
      expect(result.plan.cliente_id).toBe(w.clienteId);
      expect(await getPlan(db, w.clienteId, foreignPlan.id)).toBeNull();
      expect((await listPlanes(db, w.clienteId)).map((p) => p.id)).toEqual([result.plan.id]);
      expect((await getPlanActivoDeSemana(db, w.clienteId, w.semana))!.id).toBe(result.plan.id);
      expect((await getPlan(db, other, foreignPlan.id))!.estado).toBe('borrador');
      await expect(generarPlanSemanal(w.deps, other, { semana: w.semana }, SISTEMA)).rejects.toBeInstanceOf(NoPuedePlanificarError);
    });
  });

  it('logs contain no prompt, brand, fact or idea text', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue('basura', planJson(w));
      await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA);
      w.provider.enqueue('basura', 'más basura');
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE cliente_id = $1`, [w.clienteId]);
      await generarPlanSemanal(w.deps, w.clienteId, { semana: w.semana }, SISTEMA).catch(() => undefined);
      const logs = w.logs.join('');
      expect(logs).toContain('weekly plan stored');
      for (const hidden of [IDEA_1, IDEA_2, IDEA_3, 'Cafetería Aurora', 'cuesta $6.000', 'Reply with JSON only', 'EXTERNAL_DATA', 'basura']) {
        expect(logs, hidden).not.toContain(hidden);
      }
    });
  });
});
