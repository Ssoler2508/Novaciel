import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { assignRole, createAlerta, createAlertaReconocimiento, createCliente, createUsuario } from '../../../tests/utils/factories/index.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { registerAuth } from '../auth/authRoutes.js';
import type { RoleCode } from '../auth/permissions.js';
import { asClienteId } from '../shared/clienteId.js';
import { pageAlertas } from './alertasRepository.js';
import { registerAlertasRoutes } from './alertasRoutes.js';

// Same pattern as the other route tests: one test-transaction client as Db, app.inject(), rollback.

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const NOVACIEL: RoleCode[] = ['administrador_novaciel', 'operador_novaciel'];
const ALL_ROLES: RoleCode[] = ['administrador_novaciel', 'operador_novaciel', 'dueno_cliente', 'aprobador_cliente', 'colaborador_cliente'];

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
    await registerAlertasRoutes(app, { db });
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
const post = (ctx: Ctx, s: Session | null, url: string, payload: unknown = {}, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, headers: { ...JSON_HEADERS, ...(s?.headers ?? {}), ...headers }, payload: payload as object });

async function sessionsByRole(ctx: Ctx, clienteId: string) {
  const out = new Map<RoleCode, Session>();
  for (const rol of ALL_ROLES) out.set(rol, await login(ctx, rol, clienteId));
  return out;
}

describe('permissions per role', () => {
  it('client list: administrador, operador and dueno; aprobador and colaborador 403; no session 401', async () => {
    await withApp(async (ctx) => {
      const c = await createCliente(ctx.db);
      const sessions = await sessionsByRole(ctx, c.id);
      for (const rol of ALL_ROLES) {
        const res = await get(ctx, sessions.get(rol)!, `/clientes/${c.id}/alertas`);
        expect(res.statusCode, rol).toBe(['administrador_novaciel', 'operador_novaciel', 'dueno_cliente'].includes(rol) ? 200 : 403);
      }
      expect((await get(ctx, null, `/clientes/${c.id}/alertas`)).statusCode).toBe(401);
    });
  });

  it('the cross-client list: administrador and operador only', async () => {
    await withApp(async (ctx) => {
      const c = await createCliente(ctx.db);
      const sessions = await sessionsByRole(ctx, c.id);
      for (const rol of ALL_ROLES) expect((await get(ctx, sessions.get(rol)!, '/alertas')).statusCode, rol).toBe(NOVACIEL.includes(rol) ? 200 : 403);
      expect((await get(ctx, null, '/alertas')).statusCode).toBe(401);
    });
  });

  it('acknowledging: administrador and operador only (client and global routes); nobody else, no session 401', async () => {
    await withApp(async (ctx) => {
      const c = await createCliente(ctx.db);
      const sessions = await sessionsByRole(ctx, c.id);
      const mine = await createAlerta(ctx.db, { clienteId: c.id });
      const global = await createAlerta(ctx.db, { codigo: 'trabajo_fallido' });
      for (const rol of ['dueno_cliente', 'aprobador_cliente', 'colaborador_cliente'] as const) {
        expect((await post(ctx, sessions.get(rol)!, `/clientes/${c.id}/alertas/${mine.id}/reconocer`)).statusCode, rol).toBe(403);
        expect((await post(ctx, sessions.get(rol)!, `/alertas/${global.id}/reconocer`)).statusCode, rol).toBe(403);
      }
      expect((await post(ctx, null, `/clientes/${c.id}/alertas/${mine.id}/reconocer`)).statusCode).toBe(401);
      expect((await post(ctx, null, `/alertas/${global.id}/reconocer`)).statusCode).toBe(401);
      expect((await ctx.db.query('SELECT 1 FROM alertas_reconocimientos')).rows).toHaveLength(0);
      expect((await post(ctx, sessions.get('operador_novaciel')!, `/clientes/${c.id}/alertas/${mine.id}/reconocer`)).statusCode).toBe(200);
      expect((await post(ctx, sessions.get('administrador_novaciel')!, `/alertas/${global.id}/reconocer`)).statusCode).toBe(200);
    });
  });
});

describe('what each role sees', () => {
  it('a client owner sees only aprobacion_vencida of their own client, without the user who acknowledged it', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const b = await createCliente(ctx.db);
      const vencidaA = await createAlerta(ctx.db, { clienteId: a.id, codigo: 'aprobacion_vencida', parametros: { tipo: 'pieza', objeto_id: 'x', plazo: 'y' } });
      await createAlertaReconocimiento(ctx.db, { alertaId: vencidaA.id });
      await createAlerta(ctx.db, { clienteId: a.id, codigo: 'presupuesto_umbral_100', severidad: 'critica' });
      await createAlerta(ctx.db, { clienteId: a.id, codigo: 'aprobacion_escalada', severidad: 'critica' });
      await createAlerta(ctx.db, { clienteId: b.id, codigo: 'aprobacion_vencida' });
      await createAlerta(ctx.db, { codigo: 'trabajo_fallido' });
      const owner = await login(ctx, 'dueno_cliente', a.id);

      const res = (await get(ctx, owner, `/clientes/${a.id}/alertas`)).json();
      expect(res.items.map((i: { id: string }) => i.id)).toEqual([vencidaA.id]);
      expect(res.items[0]).toMatchObject({ cliente_id: a.id, codigo: 'aprobacion_vencida', reconocida: true, reconocida_por: null });
      expect(res.items[0].reconocida_en).not.toBeNull();
      // Another client, and the cross-client list: forbidden.
      expect((await get(ctx, owner, `/clientes/${b.id}/alertas`)).statusCode).toBe(403);
      expect((await get(ctx, owner, '/alertas')).statusCode).toBe(403);
      // Filtering by a code the owner may not see gives nothing.
      expect((await get(ctx, owner, `/clientes/${a.id}/alertas?codigo=presupuesto_umbral_100`)).json().items).toEqual([]);
    });
  });

  it('NovaCiel sees every code of a client with the acknowledging user; the cross-client list adds global alerts', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const b = await createCliente(ctx.db);
      const x = await createAlerta(ctx.db, { clienteId: a.id, codigo: 'qc_rechazada', severidad: 'info' });
      const y = await createAlerta(ctx.db, { clienteId: a.id, codigo: 'presupuesto_umbral_80' });
      const z = await createAlerta(ctx.db, { clienteId: b.id, codigo: 'qc_rechazada', severidad: 'info' });
      const g = await createAlerta(ctx.db, { codigo: 'trabajo_fallido' });
      const staff = await login(ctx, 'operador_novaciel', null);
      const ack = await createAlertaReconocimiento(ctx.db, { alertaId: x.id });

      const client = (await get(ctx, staff, `/clientes/${a.id}/alertas`)).json();
      expect(client.items.map((i: { id: string }) => i.id).sort()).toEqual([x.id, y.id].sort());
      expect(client.items.find((i: { id: string }) => i.id === x.id)).toMatchObject({ reconocida: true, reconocida_por: ack.usuario_id });
      const all = (await get(ctx, staff, '/alertas')).json();
      expect(all.items.map((i: { id: string }) => i.id).sort()).toEqual([x.id, y.id, z.id, g.id].sort());
      expect((await get(ctx, staff, '/alertas?global=true')).json().items.map((i: { id: string }) => i.id)).toEqual([g.id]);
      expect((await get(ctx, staff, `/alertas?cliente=${b.id}`)).json().items.map((i: { id: string }) => i.id)).toEqual([z.id]);
    });
  });

  it('filters by code, severity and acknowledged', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const info = await createAlerta(ctx.db, { clienteId: a.id, codigo: 'qc_rechazada', severidad: 'info' });
      const aviso = await createAlerta(ctx.db, { clienteId: a.id, codigo: 'presupuesto_umbral_80', severidad: 'aviso' });
      const critica = await createAlerta(ctx.db, { clienteId: a.id, codigo: 'presupuesto_umbral_100', severidad: 'critica' });
      await createAlertaReconocimiento(ctx.db, { alertaId: aviso.id });
      const staff = await login(ctx, 'administrador_novaciel', null);
      const ids = async (q: string) => ((await get(ctx, staff, `/clientes/${a.id}/alertas?${q}`)).json().items as { id: string }[]).map((i) => i.id).sort();
      expect(await ids('codigo=qc_rechazada')).toEqual([info.id]);
      expect(await ids('severidad=critica')).toEqual([critica.id]);
      expect(await ids('reconocida=true')).toEqual([aviso.id]);
      expect(await ids('reconocida=false')).toEqual([info.id, critica.id].sort());
      expect(await ids('reconocida=false&severidad=info')).toEqual([info.id]);
    });
  });
});

describe('pagination', () => {
  it('pages newest first with a stable cursor, with no duplicates or gaps even when alerts share the same instant', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const same = new Date('2026-11-01T10:00:00.123456Z');
      const created: string[] = [];
      for (let i = 0; i < 3; i += 1) created.push((await createAlerta(ctx.db, { clienteId: a.id, creadoEn: same })).id);
      for (let i = 0; i < 4; i += 1) created.push((await createAlerta(ctx.db, { clienteId: a.id, creadoEn: new Date(Date.UTC(2026, 10, 2, 10, i)) })).id);
      const staff = await login(ctx, 'operador_novaciel', null);
      const seen: string[] = [];
      let url = `/clientes/${a.id}/alertas?limite=3`;
      const sizes: number[] = [];
      for (let guard = 0; guard < 5; guard += 1) {
        const body = (await get(ctx, staff, url)).json();
        expect(body.limite).toBe(3);
        sizes.push(body.items.length);
        seen.push(...body.items.map((i: { id: string }) => i.id));
        if (!body.siguiente) break;
        url = `/clientes/${a.id}/alertas?limite=3&antes=${encodeURIComponent(body.siguiente)}`;
      }
      expect(sizes).toEqual([3, 3, 1]);
      expect(new Set(seen).size).toBe(7);
      expect(seen.slice(0, 4)).toEqual(created.slice(3).reverse());
      const dates = (await ctx.db.query<{ creado_en: Date }>('SELECT creado_en FROM alertas WHERE id = ANY($1) ORDER BY array_position($1::uuid[], id)', [seen])).rows.map((r) => r.creado_en.getTime());
      expect([...dates].sort((x, y) => y - x)).toEqual(dates);
    });
  });

  it('the repository clamps the limit and refuses a cursor it did not issue', async () => {
    await withTestTransaction(async (db) => {
      const a = asClienteId((await createCliente(db)).id);
      await createAlerta(db, { clienteId: a });
      expect((await pageAlertas(db, { tipo: 'novaciel', clienteId: a }, { limit: 100_000 })).items).toHaveLength(1);
      await expect(pageAlertas(db, { tipo: 'novaciel', clienteId: a }, { antes: 'no-es-un-cursor' })).rejects.toMatchObject({ name: 'CursorInvalidoError' });
    });
  });

  it('bad query parameters answer 400 and bad cursors 400, not 500', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const staff = await login(ctx, 'administrador_novaciel', null);
      for (const q of ['limite=0', 'limite=101', 'limite=abc', 'codigo=inventado', 'severidad=grave', 'reconocida=quizas', 'antes=zzz', 'otro=1']) {
        expect((await get(ctx, staff, `/clientes/${a.id}/alertas?${q}`)).statusCode, q).toBe(400);
      }
      for (const q of ['cliente=no-uuid', `cliente=${a.id}&global=true`, 'limite=0']) {
        expect((await get(ctx, staff, `/alertas?${q}`)).statusCode, q).toBe(400);
      }
    });
  });
});

describe('acknowledging', () => {
  it('records who and when, audits it once, and a second call changes nothing', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const alerta = await createAlerta(ctx.db, { clienteId: a.id, codigo: 'qc_rechazada', severidad: 'info' });
      const staff = await login(ctx, 'operador_novaciel', null);
      const other = await login(ctx, 'administrador_novaciel', null);
      const url = `/clientes/${a.id}/alertas/${alerta.id}/reconocer`;
      const first = await post(ctx, staff, url);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ id: alerta.id, reconocida: true, reconocida_por: staff.user.id, ya_reconocida: false });
      const second = await post(ctx, other, url);
      expect(second.json()).toMatchObject({ reconocida: true, reconocida_por: staff.user.id, reconocida_en: first.json().reconocida_en, ya_reconocida: true });

      expect((await ctx.db.query('SELECT usuario_id FROM alertas_reconocimientos WHERE alerta_id = $1', [alerta.id])).rows).toEqual([{ usuario_id: staff.user.id }]);
      const audit = await auditRowsFor(ctx.db, 'alertas_reconocimientos', alerta.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ accion: 'reconocer', actor_tipo: 'usuario', actor_usuario_id: staff.user.id, cliente_id: a.id, datos_despues: { codigo: 'qc_rechazada', severidad: 'info' } });
      // The alert row itself is never changed.
      expect((await ctx.db.query('SELECT codigo, severidad FROM alertas WHERE id = $1', [alerta.id])).rows).toEqual([{ codigo: 'qc_rechazada', severidad: 'info' }]);
    });
  });

  it('a global alert is acknowledged only through the global route, audited with no client', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const global = await createAlerta(ctx.db, { codigo: 'trabajo_fallido' });
      const mine = await createAlerta(ctx.db, { clienteId: a.id });
      const staff = await login(ctx, 'administrador_novaciel', null);
      expect((await post(ctx, staff, `/clientes/${a.id}/alertas/${global.id}/reconocer`)).statusCode).toBe(404);
      expect((await post(ctx, staff, `/alertas/${mine.id}/reconocer`)).statusCode).toBe(404);
      const ok = await post(ctx, staff, `/alertas/${global.id}/reconocer`);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ cliente_id: null, reconocida: true });
      const audit = await auditRowsFor(ctx.db, 'alertas_reconocimientos', global.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ cliente_id: null, actor_usuario_id: staff.user.id });
      expect((await ctx.db.query('SELECT 1 FROM alertas_reconocimientos WHERE alerta_id = $1', [mine.id])).rows).toHaveLength(0);
    });
  });

  it("another client's alert, a missing alert and a malformed id are all 404 and write nothing", async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const b = await createCliente(ctx.db);
      const deB = await createAlerta(ctx.db, { clienteId: b.id });
      const staff = await login(ctx, 'operador_novaciel', null);
      for (const id of [deB.id, '00000000-0000-4000-8000-000000000000', 'no-es-uuid']) {
        const res = await post(ctx, staff, `/clientes/${a.id}/alertas/${id}/reconocer`);
        expect(res.statusCode, id).toBe(404);
        expect(res.json()).toEqual({ error: 'not_found' });
      }
      expect((await ctx.db.query('SELECT 1 FROM alertas_reconocimientos')).rows).toHaveLength(0);
      expect((await ctx.db.query(`SELECT 1 FROM auditoria WHERE tabla = 'alertas_reconocimientos'`)).rows).toHaveLength(0);
    });
  });
});

describe('CSRF, headers and logs', () => {
  it('writes need application/json and a matching Origin; every answer is no-store; the body must be empty', async () => {
    await withApp(async (ctx) => {
      const a = await createCliente(ctx.db);
      const alerta = await createAlerta(ctx.db, { clienteId: a.id });
      const staff = await login(ctx, 'administrador_novaciel', null);
      const url = `/clientes/${a.id}/alertas/${alerta.id}/reconocer`;
      const text = await ctx.app.inject({ method: 'POST', url, headers: { ...staff.headers, 'content-type': 'text/plain' }, payload: 'x' });
      expect(text.statusCode).toBe(415);
      const evil = await post(ctx, staff, url, {}, { origin: 'http://evil.example' });
      expect(evil.statusCode).toBe(403);
      const extra = await post(ctx, staff, url, { comentario: 'texto del cliente' });
      expect(extra.statusCode).toBe(400);
      expect((await ctx.db.query('SELECT 1 FROM alertas_reconocimientos')).rows).toHaveLength(0);
      for (const res of [text, evil, extra, await get(ctx, staff, `/clientes/${a.id}/alertas`), await get(ctx, staff, '/alertas')]) {
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });
  });

  it('a server error logs only the error name', async () => {
    await withApp(async (ctx) => {
      const staff = await login(ctx, 'administrador_novaciel', null);
      await ctx.db.query('ALTER TABLE alertas RENAME TO alertas_fuera');
      const res = await get(ctx, staff, '/alertas');
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal_error' });
      expect(ctx.logs.join('')).toContain('alerts route failed');
    });
  });
});
