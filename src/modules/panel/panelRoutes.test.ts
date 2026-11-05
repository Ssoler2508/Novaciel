import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  assignRole,
  checkQC,
  createAlerta,
  createAlertaReconocimiento,
  createAprobableWorld,
  createAprobacion,
  createAutorizacionGasto,
  createCliente,
  createConfiguracionGastoCliente,
  createLibroGasto,
  createPieza,
  createPlanSemanal,
  createRevisionCalidad,
  createTope,
  createUsuario,
  currentPeriodo,
} from '../../../tests/utils/factories/index.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { registerAuth } from '../auth/authRoutes.js';
import type { RoleCode } from '../auth/permissions.js';
import { localDateOf, mondayOf } from '../planificador/fechas.js';
import { getSpendSummary } from '../presupuesto/presupuestoService.js';
import { asClienteId } from '../shared/clienteId.js';
import { registerPanelRoutes } from './panelRoutes.js';

// Same pattern as the other route tests: the single client of withTestTransaction is the Db, app.inject()
// drives the routes, everything rolls back at the end. `queries` counts every statement sent to the Db.

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];
const ALL_ROLES: RoleCode[] = ['administrador_novaciel', 'operador_novaciel', 'dueno_cliente', 'aprobador_cliente', 'colaborador_cliente'];
const DAY_MS = 86_400_000;
const SEMANA = '2026-11-02';
const COMENTARIO_SECRETO = 'COMENTARIO-SECRETO-7731';

interface Ctx {
  app: ReturnType<typeof Fastify>;
  db: Db;
  queries: { n: number };
}

async function withApp(fn: (ctx: Ctx) => Promise<void>) {
  await withTestTransaction(async (real) => {
    const queries = { n: 0 };
    const db = {
      query: (...args: unknown[]) => {
        queries.n++;
        return (real.query as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as Db;
    const app = Fastify({ loggerInstance: createLogger('debug', { write: () => undefined }) });
    await registerAuth(app, { db, allowedOrigin: ORIGIN });
    await registerPanelRoutes(app, { db });
    try {
      await fn({ app, db: real, queries });
    } finally {
      await app.close();
    }
  });
}

async function login(ctx: Ctx, rol: RoleCode, clienteId: string | null) {
  const user = await createUsuario(ctx.db, { password: PASSWORD });
  await assignRole(ctx.db, { usuarioId: user.id, rolCodigo: rol, clienteId: NOVACIEL.includes(rol) ? null : clienteId });
  const res = await ctx.app.inject({ method: 'POST', url: '/auth/login', headers: JSON_HEADERS, payload: { email: user.email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return { user, headers: { cookie: String(res.headers['set-cookie']).split(';')[0]! } };
}
type Session = Awaited<ReturnType<typeof login>>;

const get = (ctx: Ctx, s: Session | null, url: string) => ctx.app.inject({ method: 'GET', url, headers: s?.headers ?? {} });

async function sessionsByRole(ctx: Ctx, clienteId: string) {
  const out = new Map<RoleCode, Session>();
  for (const rol of ALL_ROLES) out.set(rol, await login(ctx, rol, clienteId));
  return out;
}

/** Number of statements one request sends, session and permission checks included. */
async function countQueries(ctx: Ctx, s: Session, url: string): Promise<number> {
  const before = ctx.queries.n;
  const res = await get(ctx, s, url);
  expect(res.statusCode, url).toBe(200);
  return ctx.queries.n - before;
}

describe('permissions per role', () => {
  it('client reads: NovaCiel, owner and approver; collaborator 403; no session 401', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const sessions = await sessionsByRole(ctx, cliente.id);
      for (const url of [`/clientes/${cliente.id}/panel/semana?semana=${SEMANA}`, `/clientes/${cliente.id}/panel/piezas`]) {
        for (const rol of ALL_ROLES) {
          const res = await get(ctx, sessions.get(rol)!, url);
          expect(res.statusCode, `${rol} ${url}`).toBe(rol === 'colaborador_cliente' ? 403 : 200);
          expect(res.headers['cache-control']).toBe('no-store');
        }
        expect((await get(ctx, null, url)).statusCode).toBe(401);
      }
    });
  });

  it('spend and overview: NovaCiel staff only', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const sessions = await sessionsByRole(ctx, cliente.id);
      for (const url of [`/clientes/${cliente.id}/panel/gasto`, '/panel/resumen']) {
        for (const rol of ALL_ROLES) {
          const res = await get(ctx, sessions.get(rol)!, url);
          expect(res.statusCode, `${rol} ${url}`).toBe(NOVACIEL.includes(rol) ? 200 : 403);
        }
        expect((await get(ctx, null, url)).statusCode).toBe(401);
      }
    });
  });

  it('a client role cannot read another client, whatever the route', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const b = await createCliente(ctx.db);
      const duenoB = await login(ctx, 'dueno_cliente', b.id);
      for (const url of [`/clientes/${a.id}/panel/semana`, `/clientes/${a.id}/panel/piezas`, `/clientes/${a.id}/panel/gasto`]) {
        expect((await get(ctx, duenoB, url)).statusCode, url).toBe(403);
      }
    });
  });

  it('rejects malformed queries and cursors with 400', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      for (const url of [
        `/clientes/${cliente.id}/panel/semana?semana=2026-13-45`,
        `/clientes/${cliente.id}/panel/piezas?estado=nope`,
        `/clientes/${cliente.id}/panel/piezas?limite=0`,
        `/clientes/${cliente.id}/panel/piezas?limite=101`,
        `/clientes/${cliente.id}/panel/piezas?antes=garbage`,
        `/clientes/${cliente.id}/panel/piezas?otro=1`,
        `/clientes/${cliente.id}/panel/gasto?meses=13`,
        '/panel/resumen?limite=101',
        '/panel/resumen?antes=garbage',
      ]) {
        const res = await get(ctx, admin, url);
        expect(res.statusCode, url).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_request' });
      }
    });
  });
});

describe('week overview', () => {
  it('returns the plan, its pieces with approval and QC summary, and counts that match', async () => {
    await withApp(async (ctx) => {
      const world = await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      await createAprobacion(ctx.db, { piezaId: world.piezaId, nivel: 'interno', comentario: COMENTARIO_SECRETO });
      await createPieza(ctx.db, { clienteId: world.clienteId, planId: world.planId, estado: 'planeada', idea: 'Idea ficticia visible' });
      const hash = (await ctx.db.query<{ h: string }>("SELECT encode(hash_pieza, 'hex') AS h FROM producciones WHERE id = $1", [world.produccionId])).rows[0]!.h;
      const sessions = await sessionsByRole(ctx, world.clienteId);

      for (const rol of ['administrador_novaciel', 'dueno_cliente', 'aprobador_cliente'] as const) {
        const res = await get(ctx, sessions.get(rol)!, `/clientes/${world.clienteId}/panel/semana?semana=${SEMANA}`);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.semana_inicio).toBe(SEMANA);
        expect(body.plan.id).toBe(world.planId);
        expect(body.piezas).toHaveLength(2);
        expect(body.conteos).toEqual({ revision_novaciel: 1, planeada: 1 });
        const conProduccion = body.piezas.find((p: { id: string }) => p.id === world.piezaId);
        expect(conProduccion.estado_aprobacion).toEqual({ estado: 'pendiente_cliente' });
        expect(conProduccion.control_calidad.resultado).toBe('aprobado');
        const sinProduccion = body.piezas.find((p: { id: string }) => p.id !== world.piezaId);
        expect(sinProduccion.estado_aprobacion).toBeNull();
        expect(sinProduccion.control_calidad).toBeNull();
        expect(sinProduccion.fecha_hora_local.zona_horaria).toBe(body.plan.zona_horaria);
        // Never comments, hashes or sequence numbers, whatever the role.
        expect(res.body).not.toContain(COMENTARIO_SECRETO);
        expect(res.body).not.toContain(hash);
        expect(res.body).not.toMatch(/"seq"|hash_pieza|comentario/);
      }
    });
  });

  it('QC reason codes are for NovaCiel; client roles get the result only', async () => {
    await withApp(async (ctx) => {
      const world = await createAprobableWorld(ctx.db, { estado: 'en_control_calidad', sinInformeQC: true, semanaInicio: SEMANA });
      await createRevisionCalidad(ctx.db, { piezaId: world.piezaId, checks: [checkQC('marca_color', 'advertencia'), checkQC('texto_largo', 'pasa')] });
      const sessions = await sessionsByRole(ctx, world.clienteId);
      const url = `/clientes/${world.clienteId}/panel/semana?semana=${SEMANA}`;
      const staff = (await get(ctx, sessions.get('operador_novaciel')!, url)).json().piezas[0].control_calidad;
      expect(staff.codigos_advertencia).toEqual(['marca_color']);
      expect(staff.codigos_fallo).toEqual([]);
      const client = (await get(ctx, sessions.get('dueno_cliente')!, url)).json().piezas[0].control_calidad;
      expect(Object.keys(client).sort()).toEqual(['creado_en', 'resultado', 'version']);
    });
  });

  it('without a week it returns the plan that contains today in the plan zone; none is an explicit null', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      const zona = 'America/New_York';
      const hoy = mondayOf(localDateOf(new Date(), zona));
      const vacio = await get(ctx, admin, `/clientes/${cliente.id}/panel/semana`);
      expect(vacio.json()).toEqual({ semana_inicio: null, plan: null, piezas: [], conteos: {} });

      const plan = await createPlanSemanal(ctx.db, { clienteId: cliente.id, semanaInicio: hoy, zonaHoraria: zona, estado: 'aprobado' });
      const res = await get(ctx, admin, `/clientes/${cliente.id}/panel/semana`);
      expect(res.json().plan.id).toBe(plan.id);
      // A discarded plan is treated as missing.
      const otro = await createCliente(ctx.db);
      await createPlanSemanal(ctx.db, { clienteId: otro.id, semanaInicio: hoy, zonaHoraria: zona, estado: 'descartado' });
      expect((await get(ctx, admin, `/clientes/${otro.id}/panel/semana`)).json().plan).toBeNull();
    });
  });

  it('never shows pieces of another client', async () => {
    await withApp(async (ctx) => {
      const a = await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      const b = await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      const admin = await login(ctx, 'administrador_novaciel', null);
      const body = (await get(ctx, admin, `/clientes/${a.clienteId}/panel/semana?semana=${SEMANA}`)).json();
      expect(body.piezas.map((p: { id: string }) => p.id)).toEqual([a.piezaId]);
      expect(JSON.stringify(body)).not.toContain(b.piezaId);
    });
  });
});

describe('pieces by state', () => {
  it('filters by state, paginates with a stable order and counts by state', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const plan = await createPlanSemanal(ctx.db, { clienteId: cliente.id, estado: 'aprobado' });
      const base = Date.now() + 10 * DAY_MS;
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        // Two pieces share the same instant: the id breaks the tie, so the cursor must not skip or repeat.
        const fechaHora = new Date(base + Math.min(i, 3) * 3_600_000 + 123);
        ids.push((await createPieza(ctx.db, { clienteId: cliente.id, planId: plan.id, fechaHora, red: i === 4 ? 'tiktok' : 'instagram' })).id);
      }
      const planificada = await createPieza(ctx.db, { clienteId: cliente.id, planId: plan.id, estado: 'plan_aprobado', fechaHora: new Date(base + 9 * 3_600_000) });
      const admin = await login(ctx, 'administrador_novaciel', null);

      const vistos: string[] = [];
      let url = `/clientes/${cliente.id}/panel/piezas?estado=planeada&limite=2`;
      for (let page = 0; page < 5; page++) {
        const body = (await get(ctx, admin, url)).json();
        expect(body.limite).toBe(2);
        expect(body.conteos).toEqual({ planeada: 5, plan_aprobado: 1 });
        vistos.push(...body.items.map((p: { id: string }) => p.id));
        if (!body.siguiente) break;
        url = `/clientes/${cliente.id}/panel/piezas?estado=planeada&limite=2&antes=${encodeURIComponent(body.siguiente)}`;
      }
      expect(vistos).toHaveLength(5);
      expect(new Set(vistos).size).toBe(5);
      expect(new Set(vistos)).toEqual(new Set(ids));

      const todas = (await get(ctx, admin, `/clientes/${cliente.id}/panel/piezas?estado=planeada,plan_aprobado`)).json();
      expect(todas.items).toHaveLength(6);
      expect(todas.items.at(-1).id).toBe(planificada.id);
      expect(todas.siguiente).toBeNull();
      const tiktok = (await get(ctx, admin, `/clientes/${cliente.id}/panel/piezas?red=tiktok`)).json();
      expect(tiktok.items.map((p: { id: string }) => p.id)).toEqual([ids[4]]);
    });
  });

  it('hides pieces of discarded plans and other clients', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const descartado = await createPlanSemanal(ctx.db, { clienteId: cliente.id, estado: 'descartado', semanaInicio: '2026-11-09' });
      await createPieza(ctx.db, { clienteId: cliente.id, planId: descartado.id });
      const otro = await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      const admin = await login(ctx, 'administrador_novaciel', null);
      const body = (await get(ctx, admin, `/clientes/${cliente.id}/panel/piezas`)).json();
      expect(body.items).toEqual([]);
      expect(body.conteos).toEqual({});
      expect(JSON.stringify(body)).not.toContain(otro.piezaId);
    });
  });
});

describe('spend against the ceiling', () => {
  it('shows the current month with reservations and past months settled, with ceilings', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const periodo = currentPeriodo();
      const anterior = (
        await ctx.db.query<{ p: string }>(`SELECT (date_trunc('month', now() AT TIME ZONE 'UTC')::date - interval '1 month')::date::text AS p`)
      ).rows[0]!.p;
      await createTope(ctx.db, { clienteId: cliente.id, periodo, montoTecho: '10.000000' });
      await createTope(ctx.db, { clienteId: cliente.id, periodo: anterior, montoTecho: '4.000000' });
      await createLibroGasto(ctx.db, { clienteId: cliente.id, periodo, costoReal: '2.500000' });
      await createAutorizacionGasto(ctx.db, { clienteId: cliente.id, periodo, montoEstimado: '2.500000', estado: 'reservada' });
      await createLibroGasto(ctx.db, { clienteId: cliente.id, periodo: anterior, costoReal: '1.000000' });
      const admin = await login(ctx, 'administrador_novaciel', null);

      const body = (await get(ctx, admin, `/clientes/${cliente.id}/panel/gasto?meses=3`)).json();
      expect(body.periodo).toBe(periodo);
      expect(body.interruptor_cliente).toBe(true);
      expect(body.meses.map((m: { periodo: string }) => m.periodo)).toHaveLength(3);
      expect(body.meses[0]).toEqual({ periodo, gastado: '2.500000', reservado: '2.500000', techo: '10.000000', porcentaje: 50 });
      expect(body.meses[1]).toEqual({ periodo: anterior, gastado: '1.000000', reservado: null, techo: '4.000000', porcentaje: 25 });
      expect(body.meses[2]).toMatchObject({ gastado: '0.000000', techo: null, porcentaje: null });
      // Money only: no ledger rows, purposes or models.
      expect(JSON.stringify(body)).not.toMatch(/proposito|modelo|proveedor/);
    });
  });
});

describe('NovaCiel overview', () => {
  async function pagina(ctx: Ctx, s: Session, limite: number) {
    const clientes: Array<Record<string, any>> = [];
    let url = `/panel/resumen?limite=${limite}`;
    let cabecera: Record<string, any> = {};
    for (let i = 0; i < 500; i++) {
      const body = (await get(ctx, s, url)).json();
      cabecera = body;
      clientes.push(...body.clientes);
      if (!body.siguiente) break;
      url = `/panel/resumen?limite=${limite}&antes=${encodeURIComponent(body.siguiente)}`;
    }
    return { clientes, cabecera };
  }

  it('counts by state in the window, pending without window, open alerts and budget; no client content', async () => {
    await withApp(async (ctx) => {
      const IDEA = 'IDEA-CONFIDENCIAL-5520';
      const admin = await login(ctx, 'administrador_novaciel', null);
      // Client A: one piece inside the window, one 40 days ago (outside), one in the future.
      const a = await createCliente(ctx.db, { nombre_comercial: 'AAA Cliente Ficticio Resumen', estado: 'activo' });
      const planA = await createPlanSemanal(ctx.db, { clienteId: a.id, estado: 'aprobado' });
      await createPieza(ctx.db, { clienteId: a.id, planId: planA.id, idea: IDEA, fechaHora: new Date(Date.now() - 5 * DAY_MS) });
      await createPieza(ctx.db, { clienteId: a.id, planId: planA.id, idea: IDEA, fechaHora: new Date(Date.now() - 40 * DAY_MS) });
      await createPieza(ctx.db, { clienteId: a.id, planId: planA.id, idea: IDEA, fechaHora: new Date(Date.now() + 20 * DAY_MS) });
      await createPlanSemanal(ctx.db, { clienteId: a.id, estado: 'propuesto', semanaInicio: '2026-11-16' });
      await createAlerta(ctx.db, { clienteId: a.id, codigo: 'qc_rechazada', severidad: 'info', claveDedupe: `t:${a.id}:1` });
      await createAlerta(ctx.db, { clienteId: a.id, codigo: 'presupuesto_umbral_100', severidad: 'critica', claveDedupe: `t:${a.id}:2` });
      const reconocida = await createAlerta(ctx.db, { clienteId: a.id, codigo: 'qc_rechazada', severidad: 'info', claveDedupe: `t:${a.id}:3` });
      await createAlertaReconocimiento(ctx.db, { alertaId: reconocida.id });
      await createTope(ctx.db, { clienteId: a.id, montoTecho: '10.000000' });
      await createLibroGasto(ctx.db, { clienteId: a.id, costoReal: '8.000000' });
      await createConfiguracionGastoCliente(ctx.db, { clienteId: a.id, gastoHabilitado: false });
      // Client B: a piece waiting for review, scheduled 60 days ago: pending has no window, the state count does.
      const b = await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      await ctx.db.query('UPDATE piezas SET fecha_hora = now() - interval \'60 days\' WHERE id = $1', [b.piezaId]);
      await createAlerta(ctx.db, { codigo: 'trabajo_fallido', severidad: 'aviso', claveDedupe: `t:global:${a.id}` });

      const { clientes, cabecera } = await pagina(ctx, admin, 7);
      const ra = clientes.find((c) => c.id === a.id)!;
      const rb = clientes.find((c) => c.id === b.clienteId)!;
      expect(ra.estado).toBe('activo');
      expect(ra.conteos).toEqual({ planeada: 2 });
      expect(ra.pendientes).toEqual({ novaciel: 0, cliente: 0, planes_propuestos: 1 });
      expect(ra.alertas_abiertas).toEqual({ total: 2, criticas: 1 });
      expect(ra.presupuesto).toEqual({ periodo: currentPeriodo(), techo: '10.000000', usado: '8.000000', porcentaje: 80, interruptor_cliente: false });
      expect(rb.conteos).toEqual({});
      expect(rb.pendientes).toEqual({ novaciel: 1, cliente: 0, planes_propuestos: 0 });
      expect(cabecera.ventana_dias).toBe(35);
      expect(cabecera.alertas_globales_abiertas).toBeGreaterThanOrEqual(1);
      // No repeats across pages (the cursor is keyset on name and id).
      const ids = clientes.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      // No piece text anywhere.
      expect(JSON.stringify(clientes)).not.toContain(IDEA);
      expect(JSON.stringify(clientes)).not.toMatch(/"idea"|"pilar"|comentario/);
    });
  });

  it('budget percentage matches getSpendSummary for every case', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel', null);
      const sinTecho = await createCliente(ctx.db);
      const techoCero = await createCliente(ctx.db);
      await createTope(ctx.db, { clienteId: techoCero.id, montoTecho: '0.000000' });
      const porDefecto = await createCliente(ctx.db);
      await createConfiguracionGastoCliente(ctx.db, { clienteId: porDefecto.id, techoMensualDefecto: '3.000000' });
      await createLibroGasto(ctx.db, { clienteId: porDefecto.id, costoReal: '1.000000' });
      await createAutorizacionGasto(ctx.db, { clienteId: porDefecto.id, montoEstimado: '0.500000', estado: 'reservada' });
      await createAutorizacionGasto(ctx.db, { clienteId: porDefecto.id, montoEstimado: '9.000000', estado: 'reservada', expiraEnSegundos: -10 });
      const sobre = await createCliente(ctx.db);
      await createTope(ctx.db, { clienteId: sobre.id, montoTecho: '1.000000' });
      await createLibroGasto(ctx.db, { clienteId: sobre.id, costoReal: '1.500000' });

      const { clientes } = await pagina(ctx, admin, 100);
      for (const c of [sinTecho, techoCero, porDefecto, sobre]) {
        const esperado = await getSpendSummary(ctx.db, asClienteId(c.id));
        const real = clientes.find((r) => r.id === c.id)!.presupuesto;
        expect(real.porcentaje, c.id).toBe(esperado.percentUsed);
      }
      expect(clientes.find((r) => r.id === porDefecto.id)!.presupuesto.porcentaje).toBe(50);
    });
  });
});

describe('query count is bounded (no N+1)', () => {
  it('the week overview sends the same statements for 1 and for 12 pieces', async () => {
    await withApp(async (ctx) => {
      const small = await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      const big = await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      for (let i = 0; i < 11; i++) {
        const p = await createPieza(ctx.db, { clienteId: big.clienteId, planId: big.planId, estado: 'planeada' });
        expect(p.id).toBeTruthy();
      }
      const admin = await login(ctx, 'administrador_novaciel', null);
      const nSmall = await countQueries(ctx, admin, `/clientes/${small.clienteId}/panel/semana?semana=${SEMANA}`);
      const nBig = await countQueries(ctx, admin, `/clientes/${big.clienteId}/panel/semana?semana=${SEMANA}`);
      expect(nBig).toBe(nSmall);
    });
  });

  it('the piece list sends the same statements for 1 and for 20 pieces', async () => {
    await withApp(async (ctx) => {
      const small = await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      const big = await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      for (let i = 0; i < 19; i++) await createPieza(ctx.db, { clienteId: big.clienteId, planId: big.planId });
      const admin = await login(ctx, 'administrador_novaciel', null);
      const nSmall = await countQueries(ctx, admin, `/clientes/${small.clienteId}/panel/piezas`);
      const nBig = await countQueries(ctx, admin, `/clientes/${big.clienteId}/panel/piezas?limite=100`);
      expect(nBig).toBe(nSmall);
    });
  });

  it('the overview sends the same statements for a page of 1 and of 6 clients', async () => {
    await withApp(async (ctx) => {
      for (let i = 0; i < 6; i++) await createAprobableWorld(ctx.db, { semanaInicio: SEMANA });
      const admin = await login(ctx, 'administrador_novaciel', null);
      const n1 = await countQueries(ctx, admin, '/panel/resumen?limite=1');
      const n6 = await countQueries(ctx, admin, '/panel/resumen?limite=6');
      expect(n6).toBe(n1);
    });
  });
});
