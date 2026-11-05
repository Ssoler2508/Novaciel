import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import {
  assignRole,
  createCliente,
  createConfiguracionGastoCliente,
  createLibroGasto,
  createPrecioModelo,
  createTope,
  createUsuario,
  currentPeriodo,
} from '../../../tests/utils/factories/index.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { FakeAlertSink, FakeLLMProvider } from '../../lib/ai/index.js';
import { createLogger } from '../../lib/logger/index.js';
import { generateStructured } from '../ai/generateStructured.js';
import { registerAuth } from '../auth/authRoutes.js';
import type { RoleCode } from '../auth/permissions.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { usdToMicro } from './money.js';
import { registerPresupuestoRoutes } from './presupuestoRoutes.js';
import { authorize, BudgetRefusedError } from './presupuestoService.js';

// Same pattern as the other route tests: the single client of withTestTransaction is the Db,
// app.inject() drives the routes, everything rolls back at the end.

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];
const SISTEMA = { tipo: 'sistema' } as const;
const DAY_MS = 86_400_000;
const PROMPT_SECRET = 'PROMPT-SECRET-TEXT-4711';
const OUTPUT_SECRET = 'OUTPUT-SECRET-TEXT-9283';

interface Ctx {
  app: ReturnType<typeof Fastify>;
  db: Db;
  logs: string[];
}

async function withApp(fn: (ctx: Ctx) => Promise<void>) {
  await withTestTransaction(async (db) => {
    const logs: string[] = [];
    const app = Fastify({ loggerInstance: createLogger('debug', { write: (l: string) => void logs.push(l) }) });
    await registerAuth(app, { db, allowedOrigin: ORIGIN });
    await registerPresupuestoRoutes(app, { db });
    try {
      await fn({ app, db, logs });
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
const send = (ctx: Ctx, method: 'PUT' | 'POST', s: Session | null, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method, url, headers: { ...JSON_HEADERS, ...(s?.headers ?? {}), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function monthOffset(offset: number): string {
  const [y, m] = currentPeriodo().split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

const ALL_ROLES: RoleCode[] = ['administrador_novaciel', 'operador_novaciel', 'dueno_cliente', 'aprobador_cliente', 'colaborador_cliente'];

async function sessionsByRole(ctx: Ctx, clienteId: string) {
  const out = new Map<RoleCode, Session>();
  for (const rol of ALL_ROLES) out.set(rol, await login(ctx, rol, clienteId));
  return out;
}

const priceBody = (overrides: Record<string, unknown> = {}) => ({
  proveedor: `fake_provider_${Math.random().toString(36).slice(2, 8)}`,
  modelo: 'fake-model-x',
  entrada_por_millon: '1.5',
  salida_por_millon: '7.25',
  nota: 'FAKE test price',
  ...overrides,
});

describe('permissions per role', () => {
  it('reads of a client spend: administrador and operador only; everyone else 403; no session 401', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const sessions = await sessionsByRole(ctx, cliente.id);
      for (const url of [`/clientes/${cliente.id}/presupuesto`, `/clientes/${cliente.id}/presupuesto/libro`]) {
        for (const rol of ALL_ROLES) {
          const res = await get(ctx, sessions.get(rol)!, url);
          expect(res.statusCode, `${rol} ${url}`).toBe(NOVACIEL.includes(rol) ? 200 : 403);
          if (res.statusCode === 403) expect(res.json()).toEqual({ error: 'forbidden' });
        }
        expect((await get(ctx, null, url)).statusCode).toBe(401);
      }
    });
  });

  it('ceiling and switches: administrador only', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const sessions = await sessionsByRole(ctx, cliente.id);
      const calls: Array<[string, unknown]> = [
        [`/clientes/${cliente.id}/presupuesto/techo`, { periodo: currentPeriodo(), monto: '5' }],
        [`/clientes/${cliente.id}/presupuesto/interruptor`, { habilitado: false }],
        ['/presupuesto/interruptor-global', { habilitado: true }],
      ];
      for (const [url, body] of calls) {
        for (const rol of ALL_ROLES) {
          const res = await send(ctx, 'PUT', sessions.get(rol)!, url, body);
          expect(res.statusCode, `${rol} ${url}`).toBe(rol === 'administrador_novaciel' ? 200 : 403);
        }
        expect((await send(ctx, 'PUT', null, url, body)).statusCode).toBe(401);
      }
    });
  });

  it('prices: view for administrador and operador, write for administrador only', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const sessions = await sessionsByRole(ctx, cliente.id);
      for (const rol of ALL_ROLES) {
        expect((await get(ctx, sessions.get(rol)!, '/precios')).statusCode, `${rol} list`).toBe(NOVACIEL.includes(rol) ? 200 : 403);
        const post = await send(ctx, 'POST', sessions.get(rol)!, '/precios', priceBody());
        expect(post.statusCode, `${rol} write`).toBe(rol === 'administrador_novaciel' ? 201 : 403);
      }
      expect((await get(ctx, null, '/precios')).statusCode).toBe(401);
      expect((await send(ctx, 'POST', null, '/precios', priceBody())).statusCode).toBe(401);
    });
  });
});

describe('client isolation', () => {
  it('the ledger and the summary of A never include B, and a client role of A gets 403 on B', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const b = await createCliente(ctx.db);
      await createTope(ctx.db, { clienteId: a.id, montoTecho: '10' });
      await createTope(ctx.db, { clienteId: b.id, montoTecho: '20' });
      const rowA = await createLibroGasto(ctx.db, { clienteId: a.id, costoReal: '1.000000' });
      const rowB = await createLibroGasto(ctx.db, { clienteId: b.id, costoReal: '3.000000' });
      const admin = await login(ctx, 'administrador_novaciel', null);

      const ledgerA = (await get(ctx, admin, `/clientes/${a.id}/presupuesto/libro`)).json();
      expect(ledgerA.items.map((e: { id: string }) => e.id)).toEqual([rowA.id]);
      const summaryB = (await get(ctx, admin, `/clientes/${b.id}/presupuesto`)).json();
      expect(summaryB).toMatchObject({ techo: '20.000000', gastado: '3.000000' });
      expect(JSON.stringify(ledgerA)).not.toContain(rowB.id);

      const ownerOfA = await login(ctx, 'dueno_cliente', a.id);
      expect((await get(ctx, ownerOfA, `/clientes/${b.id}/presupuesto`)).statusCode).toBe(403);
      expect((await get(ctx, ownerOfA, `/clientes/${a.id}/presupuesto`)).statusCode).toBe(403);
    });
  });

  it('a ceiling written for A leaves B untouched', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const b = await createCliente(ctx.db);
      await createTope(ctx.db, { clienteId: b.id, montoTecho: '7' });
      const admin = await login(ctx, 'administrador_novaciel', null);
      expect((await send(ctx, 'PUT', admin, `/clientes/${a.id}/presupuesto/techo`, { periodo: currentPeriodo(), monto: '3' })).statusCode).toBe(200);
      const { rows } = await ctx.db.query('SELECT monto_techo::text AS m FROM topes WHERE cliente_id = $1', [b.id]);
      expect(rows).toEqual([{ m: '7.000000' }]);
    });
  });

  it('an unknown or malformed client answers 404 on writes', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel', null);
      const ghost = '00000000-0000-4000-8000-000000000000';
      for (const id of [ghost, 'not-a-uuid']) {
        expect((await send(ctx, 'PUT', admin, `/clientes/${id}/presupuesto/techo`, { periodo: currentPeriodo(), monto: '3' })).statusCode).toBe(404);
        expect((await send(ctx, 'PUT', admin, `/clientes/${id}/presupuesto/interruptor`, { habilitado: false })).statusCode).toBe(404);
      }
    });
  });
});

describe('CSRF and headers', () => {
  it('writes need application/json and a matching Origin; responses are no-store', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      const url = `/clientes/${cliente.id}/presupuesto/interruptor`;
      const text = await ctx.app.inject({ method: 'PUT', url, headers: { ...admin.headers, 'content-type': 'text/plain' }, payload: 'x' });
      expect(text.statusCode).toBe(415);
      const evil = await send(ctx, 'PUT', admin, url, { habilitado: false }, { origin: 'http://evil.example' });
      expect(evil.statusCode).toBe(403);
      expect((await send(ctx, 'PUT', admin, '/presupuesto/interruptor-global', { habilitado: true }, { origin: ORIGIN })).statusCode).toBe(200);
      const { rows } = await ctx.db.query('SELECT gasto_habilitado FROM configuracion_gasto_cliente WHERE cliente_id = $1', [cliente.id]);
      expect(rows).toEqual([]);
      for (const res of [await get(ctx, admin, `/clientes/${cliente.id}/presupuesto`), await get(ctx, admin, '/precios'), text, evil]) {
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });
  });
});

describe('validation', () => {
  it('rejects negative, non-decimal and oversized money, bad periods and extra fields', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      const url = `/clientes/${cliente.id}/presupuesto/techo`;
      const periodo = currentPeriodo();
      for (const body of [
        { periodo, monto: '-1' },
        { periodo, monto: -1 },
        { periodo, monto: 5 },
        { periodo, monto: '1e3' },
        { periodo, monto: '1.1234567' },
        { periodo, monto: '1000000000000000' },
        { periodo, monto: '' },
        { periodo: '2026-05-15', monto: '1' },
        { periodo: '2026-13-01', monto: '1' },
        { monto: '1' },
        { periodo, monto: '1', extra: true },
      ]) {
        const res = await send(ctx, 'PUT', admin, url, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_request' });
      }
      expect((await ctx.db.query('SELECT 1 FROM topes WHERE cliente_id = $1', [cliente.id])).rows).toEqual([]);
      for (const body of [{}, { habilitado: 'no' }, { habilitado: false, extra: 1 }]) {
        expect((await send(ctx, 'PUT', admin, `/clientes/${cliente.id}/presupuesto/interruptor`, body)).statusCode).toBe(400);
        expect((await send(ctx, 'PUT', admin, '/presupuesto/interruptor-global', body)).statusCode).toBe(400);
      }
    });
  });

  it('rejects negative prices, unknown units, bad blocks and extra fields', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel', null);
      const before = Number((await ctx.db.query('SELECT count(*) AS n FROM precios_modelos')).rows[0].n);
      for (const body of [
        priceBody({ entrada_por_millon: '-1' }),
        priceBody({ salida_por_millon: 2 }),
        priceBody({ entrada_por_millon: undefined }),
        priceBody({ proveedor: '' }),
        priceBody({ unidad: 'minutos' }),
        priceBody({ extra: 1 }),
        priceBody({ vigente_desde: 'yesterday' }),
        { proveedor: 'p', modelo: 'm', unidad: 'caracteres', precio_por_bloque: '-0.1', tamano_bloque: 1000 },
        { proveedor: 'p', modelo: 'm', unidad: 'caracteres', precio_por_bloque: '0.1', tamano_bloque: 0 },
        { proveedor: 'p', modelo: 'm', unidad: 'caracteres', precio_por_bloque: '0.1', tamano_bloque: 1.5 },
        { proveedor: 'p', modelo: 'm', unidad: 'caracteres', entrada_por_millon: '1', salida_por_millon: '1' },
      ]) {
        const res = await send(ctx, 'POST', admin, '/precios', body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(Number((await ctx.db.query('SELECT count(*) AS n FROM precios_modelos')).rows[0].n)).toBe(before);
    });
  });

  it('refuses a retroactive price (400 precio_retroactivo) and a duplicate (409), and writes nothing', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel', null);
      const body = priceBody({ vigente_desde: new Date(Date.now() - DAY_MS).toISOString() });
      const retro = await send(ctx, 'POST', admin, '/precios', body);
      expect(retro.statusCode).toBe(400);
      expect(retro.json()).toEqual({ error: 'precio_retroactivo' });
      const unitRetro = await send(ctx, 'POST', admin, '/precios', { proveedor: 'p', modelo: 'm', unidad: 'segundos', precio_por_bloque: '0.1', tamano_bloque: 60, vigente_desde: new Date(Date.now() - 1000).toISOString() });
      expect(unitRetro.json()).toEqual({ error: 'precio_retroactivo' });
      expect((await ctx.db.query('SELECT 1 FROM precios_modelos WHERE proveedor = $1', [body.proveedor])).rows).toEqual([]);

      const future = priceBody({ vigente_desde: new Date(Date.now() + DAY_MS).toISOString() });
      expect((await send(ctx, 'POST', admin, '/precios', future)).statusCode).toBe(201);
      const dup = await send(ctx, 'POST', admin, '/precios', future);
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toEqual({ error: 'precio_existe' });
    });
  });

  it('refuses a past month for the ceiling (400 periodo_pasado) and accepts the current and a future one', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      const url = `/clientes/${cliente.id}/presupuesto/techo`;
      const past = await send(ctx, 'PUT', admin, url, { periodo: monthOffset(-1), monto: '9' });
      expect(past.statusCode).toBe(400);
      expect(past.json()).toEqual({ error: 'periodo_pasado' });
      expect((await ctx.db.query('SELECT 1 FROM topes WHERE cliente_id = $1', [cliente.id])).rows).toEqual([]);
      expect((await send(ctx, 'PUT', admin, url, { periodo: currentPeriodo(), monto: '9' })).statusCode).toBe(200);
      expect((await send(ctx, 'PUT', admin, url, { periodo: monthOffset(1), monto: '9' })).statusCode).toBe(200);
    });
  });

  it('pagination parameters are bounded', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      for (const q of ['limite=0', 'limite=201', 'limite=abc', 'antes=-1', 'antes=x', 'periodo=2026-05-02', 'otro=1']) {
        expect((await get(ctx, admin, `/clientes/${cliente.id}/presupuesto/libro?${q}`)).statusCode, q).toBe(400);
      }
      for (const q of ['limite=0', 'limite=201', 'desde=-1', 'otro=1']) {
        expect((await get(ctx, admin, `/precios?${q}`)).statusCode, q).toBe(400);
      }
    });
  });
});

describe('audit rows', () => {
  it('a ceiling creates then updates the topes row, with before and after, and flags a ceiling below the spend', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      await createLibroGasto(ctx.db, { clienteId: cliente.id, costoReal: '4.000000' });
      const admin = await login(ctx, 'administrador_novaciel', null);
      const url = `/clientes/${cliente.id}/presupuesto/techo`;
      const first = await send(ctx, 'PUT', admin, url, { periodo: currentPeriodo(), monto: '10' });
      expect(first.json()).toEqual({ periodo: currentPeriodo(), techo_anterior: null, techo: '10.000000', por_debajo_del_gasto: false });
      const second = await send(ctx, 'PUT', admin, url, { periodo: currentPeriodo(), monto: '3.5' });
      expect(second.json()).toEqual({ periodo: currentPeriodo(), techo_anterior: '10.000000', techo: '3.500000', por_debajo_del_gasto: true });

      const { rows } = await ctx.db.query<{ id: string }>('SELECT id FROM topes WHERE cliente_id = $1', [cliente.id]);
      expect(rows).toHaveLength(1);
      const audit = await auditRowsFor(ctx.db, 'topes', rows[0]!.id);
      expect(audit.map((a) => a.accion)).toEqual(['crear', 'actualizar']);
      expect(audit[0]).toMatchObject({ actor_tipo: 'usuario', actor_usuario_id: admin.user.id, cliente_id: cliente.id, datos_antes: null });
      expect(audit[1]).toMatchObject({
        cliente_id: cliente.id,
        datos_antes: { monto_techo: '10.000000' },
        datos_despues: { monto_techo: '3.500000', por_debajo_del_gasto: true },
      });
    });
  });

  it('the client switch and the global switch are audited with before and after', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      const off = await send(ctx, 'PUT', admin, `/clientes/${cliente.id}/presupuesto/interruptor`, { habilitado: false });
      expect(off.json()).toEqual({ interruptor_cliente: false, anterior: true });
      await send(ctx, 'PUT', admin, `/clientes/${cliente.id}/presupuesto/interruptor`, { habilitado: true });
      const audit = await auditRowsFor(ctx.db, 'configuracion_gasto_cliente', cliente.id);
      expect(audit.map((a) => [a.datos_antes, a.datos_despues])).toEqual([
        [{ gasto_habilitado: true }, { gasto_habilitado: false }],
        [{ gasto_habilitado: false }, { gasto_habilitado: true }],
      ]);
      expect(audit[0]).toMatchObject({ actor_usuario_id: admin.user.id, cliente_id: cliente.id });

      const global = await send(ctx, 'PUT', admin, '/presupuesto/interruptor-global', { habilitado: false });
      expect(global.json()).toEqual({ interruptor_global: false, anterior: true });
      const globalAudit = await auditRowsFor(ctx.db, 'interruptor_global', 'global');
      expect(globalAudit).toHaveLength(1);
      expect(globalAudit[0]).toMatchObject({ actor_usuario_id: admin.user.id, cliente_id: null, datos_antes: { gasto_habilitado: true }, datos_despues: { gasto_habilitado: false } });
      const row = await ctx.db.query('SELECT gasto_habilitado, actualizado_por FROM interruptor_global');
      expect(row.rows).toEqual([{ gasto_habilitado: false, actualizado_por: admin.user.id }]);
    });
  });

  it('a price (tokens and unit) is a new audited row with no client', async () => {
    await withApp(async (ctx) => {
      const admin = await login(ctx, 'administrador_novaciel', null);
      const tokens = (await send(ctx, 'POST', admin, '/precios', priceBody())).json();
      expect(tokens).toMatchObject({ unidad: 'tokens', entrada_por_millon: '1.500000', salida_por_millon: '7.250000', nota: 'FAKE test price' });
      const unit = (await send(ctx, 'POST', admin, '/precios', { proveedor: 'fake_voice', modelo: 'fake-voice-x', unidad: 'caracteres', precio_por_bloque: '0.08', tamano_bloque: 1000 })).json();
      expect(unit).toMatchObject({ unidad: 'caracteres', precio_por_bloque: '0.080000', tamano_bloque: 1000 });
      for (const created of [tokens, unit]) {
        const audit = await auditRowsFor(ctx.db, 'precios_modelos', created.id);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ accion: 'crear', actor_usuario_id: admin.user.id, cliente_id: null });
      }
    });
  });

  it('refused or invalid writes leave no audit rows', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const operator = await login(ctx, 'operador_novaciel', null);
      const admin = await login(ctx, 'administrador_novaciel', null);
      const before = Number((await ctx.db.query('SELECT count(*) AS n FROM auditoria WHERE tabla IN ($1, $2, $3, $4)', ['topes', 'configuracion_gasto_cliente', 'interruptor_global', 'precios_modelos'])).rows[0].n);
      await send(ctx, 'PUT', operator, `/clientes/${cliente.id}/presupuesto/techo`, { periodo: currentPeriodo(), monto: '3' });
      await send(ctx, 'PUT', operator, '/presupuesto/interruptor-global', { habilitado: false });
      await send(ctx, 'POST', operator, '/precios', priceBody());
      await send(ctx, 'PUT', admin, `/clientes/${cliente.id}/presupuesto/techo`, { periodo: monthOffset(-2), monto: '3' });
      await send(ctx, 'PUT', admin, `/clientes/${cliente.id}/presupuesto/techo`, { periodo: currentPeriodo(), monto: '-3' });
      const after = Number((await ctx.db.query('SELECT count(*) AS n FROM auditoria WHERE tabla IN ($1, $2, $3, $4)', ['topes', 'configuracion_gasto_cliente', 'interruptor_global', 'precios_modelos'])).rows[0].n);
      expect(after).toBe(before);
    });
  });
});

describe('the switches and ceiling block the next paid call (fake provider)', () => {
  const schema = z.object({ title: z.string() });
  const VALID = JSON.stringify({ title: 'ok' });

  async function paidCallWorld(db: Db) {
    const clienteId: ClienteId = asClienteId((await createCliente(db)).id);
    await createTope(db, { clienteId, montoTecho: '10' });
    const priced = await db.query(`SELECT 1 FROM precios_modelos WHERE proveedor = 'fake' AND modelo = 'fake-model'`);
    if (priced.rows.length === 0) await createPrecioModelo(db, { proveedor: 'fake', modelo: 'fake-model', precioEntrada: '1', precioSalida: '2' });
    const provider = new FakeLLMProvider({ inputTokens: 100, outputTokens: 50 });
    const alerts = new FakeAlertSink();
    const run = () =>
      generateStructured(
        { db, provider, alerts, logger: createLogger('silent') },
        { clienteId, purpose: 'smoke_test_pesado', schema, prompt: { system: 'Return JSON.', user: 'hello' }, maxOutputTokens: 1000, actor: SISTEMA },
      );
    return { clienteId, provider, run };
  }

  it('the client switch off refuses the next call without calling the provider; on again lets it through', async () => {
    await withApp(async (ctx) => {
      const w = await paidCallWorld(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      w.provider.enqueue(VALID, VALID);
      await send(ctx, 'PUT', admin, `/clientes/${w.clienteId}/presupuesto/interruptor`, { habilitado: false });
      await expect(w.run()).rejects.toMatchObject({ name: 'BudgetRefusedError', reason: 'interruptor_cliente' });
      expect(w.provider.calls).toHaveLength(0);
      await send(ctx, 'PUT', admin, `/clientes/${w.clienteId}/presupuesto/interruptor`, { habilitado: true });
      await expect(w.run()).resolves.toMatchObject({ attempts: 1 });
      expect(w.provider.calls).toHaveLength(1);
    });
  });

  it('the global switch off refuses every client; on again lets them through', async () => {
    await withApp(async (ctx) => {
      const w1 = await paidCallWorld(ctx.db);
      const w2 = await paidCallWorld(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      w1.provider.enqueue(VALID);
      w2.provider.enqueue(VALID);
      await send(ctx, 'PUT', admin, '/presupuesto/interruptor-global', { habilitado: false });
      await expect(w1.run()).rejects.toMatchObject({ reason: 'interruptor_global' });
      await expect(w2.run()).rejects.toMatchObject({ reason: 'interruptor_global' });
      expect(w1.provider.calls).toHaveLength(0);
      expect(w2.provider.calls).toHaveLength(0);
      await send(ctx, 'PUT', admin, '/presupuesto/interruptor-global', { habilitado: true });
      await expect(w1.run()).resolves.toMatchObject({ attempts: 1 });
    });
  });

  it('a ceiling set below the spend is allowed and the next authorization is refused', async () => {
    await withApp(async (ctx) => {
      const w = await paidCallWorld(ctx.db);
      w.provider.enqueue(VALID);
      await w.run(); // spends 0.000200
      const admin = await login(ctx, 'administrador_novaciel', null);
      const res = await send(ctx, 'PUT', admin, `/clientes/${w.clienteId}/presupuesto/techo`, { periodo: currentPeriodo(), monto: '0.0001' });
      expect(res.statusCode).toBe(200);
      expect(res.json().por_debajo_del_gasto).toBe(true);
      await expect(authorize(ctx.db, w.clienteId, { estimatedCost: usdToMicro('0.000001'), purpose: 'test_purpose', provider: 'fake', model: 'fake-model' }, SISTEMA)).rejects.toBeInstanceOf(BudgetRefusedError);
      const summary = (await get(ctx, admin, `/clientes/${w.clienteId}/presupuesto`)).json();
      expect(summary).toMatchObject({ techo: '0.000100', gastado: '0.000200', restante: '0.000000', porcentaje: 200 });
    });
  });
});

describe('reads', () => {
  it('the summary shows ceiling, spent, reserved, remaining, percentage and the switches', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      await createConfiguracionGastoCliente(ctx.db, { clienteId: cliente.id, gastoHabilitado: false, techoMensualDefecto: '8' });
      await createTope(ctx.db, { clienteId: cliente.id, montoTecho: '10' });
      await createLibroGasto(ctx.db, { clienteId: cliente.id, costoReal: '2.500000' });
      const admin = await login(ctx, 'operador_novaciel', null);
      const res = await get(ctx, admin, `/clientes/${cliente.id}/presupuesto`);
      expect(res.json()).toEqual({
        periodo: currentPeriodo(),
        techo: '10.000000',
        gastado: '2.500000',
        reservado: '0.000000',
        restante: '7.500000',
        porcentaje: 25,
        techo_mensual_defecto: '8.000000',
        interruptor_global: true,
        interruptor_cliente: false,
      });
      const empty = await createCliente(ctx.db);
      expect((await get(ctx, admin, `/clientes/${empty.id}/presupuesto`)).json()).toMatchObject({ techo: null, restante: null, porcentaje: null, interruptor_cliente: true });
    });
  });

  it('the ledger pages newest first with a stable cursor and no duplicates', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1) created.push((await createLibroGasto(ctx.db, { clienteId: cliente.id, costoReal: `${i + 1}.000000` })).id);
      await createLibroGasto(ctx.db, { clienteId: cliente.id, periodo: monthOffset(-1) });
      const admin = await login(ctx, 'administrador_novaciel', null);
      const seen: string[] = [];
      let url = `/clientes/${cliente.id}/presupuesto/libro?limite=2`;
      const sizes: number[] = [];
      for (let guard = 0; guard < 5; guard += 1) {
        const body = (await get(ctx, admin, url)).json();
        expect(body.limite).toBe(2);
        sizes.push(body.items.length);
        seen.push(...body.items.map((e: { id: string }) => e.id));
        if (!body.siguiente) break;
        url = `/clientes/${cliente.id}/presupuesto/libro?limite=2&antes=${body.siguiente}`;
      }
      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual([...created].reverse());
      const lastMonth = (await get(ctx, admin, `/clientes/${cliente.id}/presupuesto/libro?periodo=${monthOffset(-1)}`)).json();
      expect(lastMonth.items).toHaveLength(1);
    });
  });

  it('the ledger never contains prompts or outputs: only the agreed columns', async () => {
    await withApp(async (ctx) => {
      const w = await (async () => {
        const clienteId = asClienteId((await createCliente(ctx.db)).id);
        await createTope(ctx.db, { clienteId, montoTecho: '10' });
        const priced = await ctx.db.query(`SELECT 1 FROM precios_modelos WHERE proveedor = 'fake' AND modelo = 'fake-model'`);
        if (priced.rows.length === 0) await createPrecioModelo(ctx.db, { proveedor: 'fake', modelo: 'fake-model', precioEntrada: '1', precioSalida: '2' });
        return { clienteId };
      })();
      const provider = new FakeLLMProvider({ inputTokens: 100, outputTokens: 50 }).enqueue(JSON.stringify({ title: OUTPUT_SECRET }));
      await generateStructured(
        { db: ctx.db, provider, alerts: new FakeAlertSink(), logger: createLogger('silent') },
        {
          clienteId: w.clienteId,
          purpose: 'smoke_test_pesado',
          schema: z.object({ title: z.string() }),
          prompt: { system: 'Return JSON.', user: `Write about ${PROMPT_SECRET}.` },
          maxOutputTokens: 1000,
          actor: SISTEMA,
        },
      );
      const admin = await login(ctx, 'administrador_novaciel', null);
      const res = await get(ctx, admin, `/clientes/${w.clienteId}/presupuesto/libro`);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(Object.keys(body.items[0]).sort()).toEqual(
        ['costo', 'creado_en', 'id', 'modelo', 'proposito', 'proveedor', 'resultado', 'unidad', 'unidades_entrada', 'unidades_salida'].sort(),
      );
      expect(body.items[0]).toMatchObject({ proposito: 'smoke_test_pesado', modelo: 'fake-model', unidad: 'tokens', unidades_entrada: '100', unidades_salida: '50', costo: '0.000200', resultado: 'ok' });
      expect(res.body).not.toContain(PROMPT_SECRET);
      expect(res.body).not.toContain(OUTPUT_SECRET);
      expect(ctx.logs.join('')).not.toContain(PROMPT_SECRET);
    });
  });

  it('the price list is newest first, marks vigente / futuro / anterior and pages with a bounded limit', async () => {
    await withApp(async (ctx) => {
      const provider = `fake_list_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      await createPrecioModelo(ctx.db, { proveedor: provider, modelo: 'm', vigenteDesde: new Date(now - 10 * DAY_MS), precioEntrada: '1', precioSalida: '1' });
      await createPrecioModelo(ctx.db, { proveedor: provider, modelo: 'm', vigenteDesde: new Date(now - 2 * DAY_MS), precioEntrada: '2', precioSalida: '2' });
      await createPrecioModelo(ctx.db, { proveedor: provider, modelo: 'm', vigenteDesde: new Date(now + 5 * DAY_MS), precioEntrada: '5', precioSalida: '5' });
      const operator = await login(ctx, 'operador_novaciel', null);
      const all = (await get(ctx, operator, '/precios?limite=200')).json();
      const mine = all.items.filter((p: { proveedor: string }) => p.proveedor === provider);
      expect(mine.map((p: { estado: string; entrada_por_millon: string }) => [p.entrada_por_millon, p.estado])).toEqual([
        ['5.000000', 'futuro'],
        ['2.000000', 'vigente'],
        ['1.000000', 'anterior'],
      ]);
      const dates = all.items.map((p: { vigente_desde: string }) => p.vigente_desde);
      expect([...dates].sort().reverse()).toEqual(dates);
      const page = (await get(ctx, operator, '/precios?limite=1&desde=1')).json();
      expect(page.items).toHaveLength(1);
      expect(page.items[0].id).toBe(all.items[1].id);
      expect(page.total).toBe(all.total);
    });
  });
});

describe('errors', () => {
  it('log only the error name, never request content', async () => {
    await withApp(async (ctx) => {
      const cliente = await createCliente(ctx.db);
      const admin = await login(ctx, 'administrador_novaciel', null);
      await send(ctx, 'PUT', admin, `/clientes/${cliente.id}/presupuesto/techo`, { periodo: currentPeriodo(), monto: 'SECRET-NOTE-123' });
      await send(ctx, 'POST', admin, '/precios', priceBody({ nota: 'SECRET-NOTE-123', entrada_por_millon: '-1' }));
      expect(ctx.logs.join('')).not.toContain('SECRET-NOTE-123');
    });
  });
});
