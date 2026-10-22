import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import {
  assignRole,
  createActores,
  createAprobadoresCliente,
  createCliente,
  createPieza,
  createPiezaAprobable,
  createPlanSemanal,
  createProduccion,
  createUsuarioConRol,
  type Actores,
  type PiezaAprobable,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeNotifier } from '../../lib/notificaciones/notifiers.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { asClienteId } from '../shared/clienteId.js';
import { getHuellaPlan } from './aprobacionesRepository.js';
import { reabrirPieza, registrarDecision } from './aprobacionesService.js';
import { decidirPlan, proponerPlan } from './planAprobacionService.js';
import { ejecutarJobRecordatorio } from './recordatoriosJobs.js';
import { FakeRecordatorios, planificarAvisos, type PayloadRecordatorio } from './recordatoriosPort.js';

const H = 3_600_000;
const SECRETO = 'Texto secreto del cliente que nunca debe salir en un log';

interface Mundo {
  db: Db;
  w: PiezaAprobable;
  actores: Actores;
  clienteId: ReturnType<typeof asClienteId>;
  principal: string;
  suplente: string;
  /** Payloads of the three notices of the piece, ready to be fired. */
  payloads: Record<'recordatorio_24h' | 'recordatorio_4h' | 'turno_suplente', PayloadRecordatorio>;
  plazo: Date;
}

/** A piece waiting for the client, with a main approver and a substitute of its own. */
async function mundo(db: Db): Promise<Mundo> {
  const w = await createPiezaAprobable(db, new FakeStorage());
  const actores = await createActores(db, w.clienteId);
  const clienteId = asClienteId(w.clienteId);
  const principal = (await createUsuarioConRol(db, 'aprobador_cliente', w.clienteId)).id;
  const suplente = (await createUsuarioConRol(db, 'dueno_cliente', w.clienteId)).id;
  await createAprobadoresCliente(db, { clienteId: w.clienteId, principalUsuarioId: principal, suplenteUsuarioId: suplente });
  const recordatorios = new FakeRecordatorios();
  await registrarDecision({ db, recordatorios }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
  const programado = recordatorios.programados[0]!;
  // The piece is due in 3 days; ask for all three notices as if it were scheduled a week ahead.
  const avisos = planificarAvisos(programado.input, new Date(programado.input.plazo.getTime() - 7 * 24 * H));
  const payloads = Object.fromEntries(avisos.map((a) => [a.aviso, a.payload])) as Mundo['payloads'];
  return { db, w, actores, clienteId, principal, suplente, payloads, plazo: programado.input.plazo };
}

const enHoras = (m: Mundo, horasAntes: number) => new Date(m.plazo.getTime() - horasAntes * H);
const mensajes = (n: FakeNotifier) => n.enviados.map((e) => [e.plantilla, e.destinatarioUsuarioId]);

describe('the services schedule the reminders when the client starts to wait', () => {
  it('an internal approval that leaves the piece waiting asks for the three notices, once, with the production hash', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      expect(Object.keys(m.payloads)).toEqual(['recordatorio_24h', 'recordatorio_4h', 'turno_suplente']);
      const p = m.payloads.recordatorio_24h;
      expect(p).toMatchObject({ clienteId: m.w.clienteId, tipo: 'pieza', objetoId: m.w.piezaId, referencia: m.w.hashHex, plazo: m.plazo.toISOString() });
    });
  });

  it('nothing is scheduled for a decision that does not leave the piece waiting for the client', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage());
      const actores = await createActores(db, w.clienteId);
      const clienteId = asClienteId(w.clienteId);
      const recordatorios = new FakeRecordatorios();
      await registrarDecision({ db, recordatorios }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'cambios', hashVisto: w.hashHex, motivo: 'texto' });
      expect(recordatorios.programados).toEqual([]);
    });
  });

  it('proposing a plan schedules reminders before the first piece of the week is due', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const plan = await createPlanSemanal(db, { clienteId: cliente.id });
      const tarde = new Date(Date.now() + 5 * 24 * H);
      const temprano = new Date(Date.now() + 3 * 24 * H);
      await createPieza(db, { clienteId: cliente.id, planId: plan.id, fechaHora: tarde });
      await createPieza(db, { clienteId: cliente.id, planId: plan.id, fechaHora: temprano });
      const actores = await createActores(db, cliente.id);
      const recordatorios = new FakeRecordatorios();
      await proponerPlan({ db, recordatorios }, asClienteId(cliente.id), plan.id, actores.novaciel);
      const { input, avisos } = recordatorios.programados[0]!;
      expect(input).toMatchObject({ tipo: 'plan', objetoId: plan.id, plazo: temprano, zona: plan.zona_horaria });
      expect(input.referencia).toBe(await getHuellaPlan(db, asClienteId(cliente.id), plan.id));
      expect(avisos.map((a) => a.aviso)).toEqual(['recordatorio_24h', 'recordatorio_4h', 'turno_suplente']);
    });
  });
});

describe('ejecutarJobRecordatorio: the notices', () => {
  it('sends the 24 h and 4 h reminders to the main approver and the substitute turn to the substitute', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      const notifier = new FakeNotifier();
      const run = (aviso: keyof Mundo['payloads'], horasAntes: number) => ejecutarJobRecordatorio({ db, notifier }, m.payloads[aviso], 'job', enHoras(m, horasAntes));
      expect(await run('recordatorio_24h', 24)).toEqual({ resultado: 'enviado', plantilla: 'recordatorio_24h', destinatarios: 1 });
      expect(await run('recordatorio_4h', 4)).toMatchObject({ resultado: 'enviado', plantilla: 'recordatorio_4h' });
      expect(await run('turno_suplente', 2)).toMatchObject({ resultado: 'enviado', plantilla: 'turno_suplente' });
      expect(mensajes(notifier)).toEqual([
        ['recordatorio_24h', m.principal],
        ['recordatorio_4h', m.principal],
        ['turno_suplente', m.suplente],
      ]);
      expect(notifier.enviados[0]).toEqual({ clienteId: m.w.clienteId, destinatarioUsuarioId: m.principal, plantilla: 'recordatorio_24h', referencia: { tipo: 'pieza', id: m.w.piezaId } });
    });
  });

  it('a client without a substitute simply has no substitute turn', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      await db.query('UPDATE aprobadores_cliente SET suplente_usuario_id = NULL WHERE cliente_id = $1', [m.w.clienteId]);
      const notifier = new FakeNotifier();
      expect(await ejecutarJobRecordatorio({ db, notifier }, m.payloads.turno_suplente, 'job', enHoras(m, 2))).toEqual({ resultado: 'omitido', codigo: 'sin_suplente' });
      expect(notifier.enviados).toEqual([]);
    });
  });

  it('does nothing once the client decided: approved, changes requested or rejected', async () => {
    for (const decision of ['aprobada', 'cambios', 'rechazada'] as const) {
      await withTestTransaction(async (db) => {
        const m = await mundo(db);
        await registrarDecision({ db }, m.clienteId, m.w.piezaId, m.actores.cliente, {
          nivel: 'cliente', decision, hashVisto: m.w.hashHex, ...(decision === 'aprobada' ? {} : { motivo: 'texto' as const }),
        });
        const notifier = new FakeNotifier();
        for (const aviso of ['recordatorio_24h', 'recordatorio_4h', 'turno_suplente'] as const) {
          expect(await ejecutarJobRecordatorio({ db, notifier }, m.payloads[aviso], 'job', enHoras(m, 3)), decision).toEqual({ resultado: 'omitido', codigo: 'ya_decidida' });
        }
        expect(notifier.enviados, decision).toEqual([]);
      });
    }
  });

  it('does nothing after a new production version (the notice was about the old hash) or when the piece was pulled back', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      await registrarDecision({ db }, m.clienteId, m.w.piezaId, m.actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: m.w.hashHex });
      await reabrirPieza({ db }, m.clienteId, m.w.piezaId, m.actores.novaciel, 'cambio posterior');
      // NovaCiel takes it up again and produces version 2 (another hash).
      await transitionPieza(db, m.clienteId, m.w.piezaId, 'en_produccion', { tipo: 'sistema' });
      await createProduccion(db, { piezaId: m.w.piezaId });
      const notifier = new FakeNotifier();
      const salida = await ejecutarJobRecordatorio({ db, notifier }, m.payloads.recordatorio_4h, 'job', enHoras(m, 4));
      expect(salida).toMatchObject({ resultado: 'omitido' });
      expect(notifier.enviados).toEqual([]);
    });
  });

  it('does nothing when the production changed but the piece waits again (another hash), or the deadline moved, or it is overdue', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      const notifier = new FakeNotifier();
      const run = (payload: PayloadRecordatorio, ahora: Date) => ejecutarJobRecordatorio({ db, notifier }, payload, 'job', ahora);
      expect(await run({ ...m.payloads.recordatorio_4h, referencia: 'f'.repeat(64) }, enHoras(m, 4))).toEqual({ resultado: 'omitido', codigo: 'produccion_cambiada' });
      await db.query('UPDATE piezas SET fecha_hora = fecha_hora + interval \'1 day\' WHERE id = $1', [m.w.piezaId]);
      expect(await run(m.payloads.recordatorio_4h, enHoras(m, 4))).toEqual({ resultado: 'omitido', codigo: 'plazo_cambiado' });
      expect(await run(m.payloads.recordatorio_4h, new Date(m.plazo.getTime() + H))).toEqual({ resultado: 'omitido', codigo: 'plazo_vencido' });
      expect(notifier.enviados).toEqual([]);
    });
  });

  it('plans: reminds while the plan is proposed, and does nothing once the client decided or the plan changed', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const clienteId = asClienteId(cliente.id);
      const plan = await createPlanSemanal(db, { clienteId: cliente.id });
      await createPieza(db, { clienteId: cliente.id, planId: plan.id, fechaHora: new Date(Date.now() + 3 * 24 * H) });
      const actores = await createActores(db, cliente.id);
      const principal = actores.ids.cliente;
      await createAprobadoresCliente(db, { clienteId: cliente.id, principalUsuarioId: principal });
      const recordatorios = new FakeRecordatorios();
      await proponerPlan({ db, recordatorios }, clienteId, plan.id, actores.novaciel);
      const { input, avisos } = recordatorios.programados[0]!;
      const payload = avisos[0]!.payload;
      const notifier = new FakeNotifier();
      const ahora = new Date(input.plazo.getTime() - 24 * H);
      expect(await ejecutarJobRecordatorio({ db, notifier }, payload, 'job', ahora)).toMatchObject({ resultado: 'enviado', plantilla: 'recordatorio_24h' });
      expect(notifier.enviados[0]).toMatchObject({ destinatarioUsuarioId: principal, referencia: { tipo: 'plan', id: plan.id } });

      // The plan changed while it was shown: another fingerprint.
      await db.query(`UPDATE piezas SET idea = 'Idea nueva ficticia' WHERE plan_id = $1`, [plan.id]);
      expect(await ejecutarJobRecordatorio({ db, notifier }, payload, 'job', ahora)).toEqual({ resultado: 'omitido', codigo: 'plan_cambiado' });
      await db.query(`UPDATE piezas SET idea = 'Idea ficticia original' WHERE plan_id = $1`, [plan.id]);

      // Decided: nothing more.
      const huella = await getHuellaPlan(db, clienteId, plan.id);
      const payloadActual = { ...payload, referencia: huella };
      await decidirPlan({ db }, clienteId, plan.id, actores.cliente, { decision: 'aprobado', huellaVista: huella });
      expect(await ejecutarJobRecordatorio({ db, notifier }, payloadActual, 'job', ahora)).toEqual({ resultado: 'omitido', codigo: 'ya_decidido' });
      expect(notifier.enviados).toHaveLength(1);
    });
  });
});

describe('ejecutarJobRecordatorio: the recipient is re-validated when the job fires', () => {
  async function staffIds(db: Db) {
    const { rows } = await db.query<{ id: string }>(`SELECT DISTINCT u.id FROM usuarios u JOIN usuario_roles ur ON ur.usuario_id = u.id WHERE u.activo AND ur.ambito = 'novaciel' ORDER BY u.id`);
    return rows.map((r) => r.id);
  }

  it('a main approver whose role was revoked: NovaCiel staff are told instead, and the approver is not', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      await db.query(`DELETE FROM usuario_roles WHERE usuario_id = $1`, [m.principal]);
      const notifier = new FakeNotifier();
      const salida = await ejecutarJobRecordatorio({ db, notifier }, m.payloads.recordatorio_24h, 'job', enHoras(m, 24));
      const staff = await staffIds(db);
      expect(salida).toEqual({ resultado: 'enviado', plantilla: 'aprobador_no_configurado', destinatarios: staff.length });
      expect(staff).toContain(m.actores.ids.novaciel);
      expect(notifier.enviados.every((e) => e.plantilla === 'aprobador_no_configurado' && staff.includes(e.destinatarioUsuarioId))).toBe(true);
      expect(notifier.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(m.principal);
    });
  });

  it('an inactive main approver, and an inactive or role-less substitute on its turn', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      await db.query('UPDATE usuarios SET activo = false WHERE id = $1', [m.principal]);
      const a = new FakeNotifier();
      expect(await ejecutarJobRecordatorio({ db, notifier: a }, m.payloads.recordatorio_4h, 'job', enHoras(m, 4))).toMatchObject({ plantilla: 'aprobador_no_configurado' });
      expect(a.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(m.principal);

      await db.query('UPDATE usuarios SET activo = false WHERE id = $1', [m.suplente]);
      const b = new FakeNotifier();
      expect(await ejecutarJobRecordatorio({ db, notifier: b }, m.payloads.turno_suplente, 'job', enHoras(m, 2))).toMatchObject({ plantilla: 'aprobador_no_configurado' });
      expect(b.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(m.suplente);

      await db.query('UPDATE usuarios SET activo = true WHERE id = $1', [m.suplente]);
      await db.query('DELETE FROM usuario_roles WHERE usuario_id = $1', [m.suplente]);
      const c = new FakeNotifier();
      expect(await ejecutarJobRecordatorio({ db, notifier: c }, m.payloads.turno_suplente, 'job', enHoras(m, 2))).toMatchObject({ plantilla: 'aprobador_no_configurado' });
    });
  });

  it("an approver who is now NovaCiel staff, or who only holds a role for another client, is not valid either", async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      await assignRole(db, { usuarioId: m.principal, rolCodigo: 'operador_novaciel' });
      const a = new FakeNotifier();
      expect(await ejecutarJobRecordatorio({ db, notifier: a }, m.payloads.recordatorio_24h, 'job', enHoras(m, 24))).toMatchObject({ plantilla: 'aprobador_no_configurado' });
      expect(a.enviados.map((e) => e.destinatarioUsuarioId)).toContain(m.principal); // as staff, it is told as staff
      expect(a.enviados.every((e) => e.plantilla === 'aprobador_no_configurado')).toBe(true);

      const otro = await createCliente(db);
      const foraneo = (await createUsuarioConRol(db, 'aprobador_cliente', otro.id)).id;
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE aprobadores_cliente DISABLE TRIGGER aprobadores_cliente_guard');
      await db.query('UPDATE aprobadores_cliente SET suplente_usuario_id = $2 WHERE cliente_id = $1', [m.w.clienteId, foraneo]);
      const b = new FakeNotifier();
      expect(await ejecutarJobRecordatorio({ db, notifier: b }, m.payloads.turno_suplente, 'job', enHoras(m, 2))).toMatchObject({ plantilla: 'aprobador_no_configurado' });
      expect(b.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(foraneo);
    });
  });

  it('a client with no approvers configured: NovaCiel staff are told', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      await db.query('DELETE FROM aprobadores_cliente WHERE cliente_id = $1', [m.w.clienteId]);
      const notifier = new FakeNotifier();
      const salida = await ejecutarJobRecordatorio({ db, notifier }, m.payloads.recordatorio_24h, 'job', enHoras(m, 24));
      expect(salida).toMatchObject({ resultado: 'enviado', plantilla: 'aprobador_no_configurado' });
      expect(notifier.enviados.length).toBeGreaterThan(0);
    });
  });
});

describe('ejecutarJobRecordatorio: isolation, payloads and logs', () => {
  it("a job of client A never reads or notifies about B's piece", async () => {
    await withTestTransaction(async (db) => {
      const a = await mundo(db);
      const b = await mundo(db);
      const notifier = new FakeNotifier();
      const cruzado = { ...b.payloads.recordatorio_24h, clienteId: a.w.clienteId };
      expect(await ejecutarJobRecordatorio({ db, notifier }, cruzado, 'job', enHoras(b, 24))).toEqual({ resultado: 'omitido', codigo: 'objeto_no_encontrado' });
      expect(notifier.enviados).toEqual([]);
    });
  });

  it('rejects a payload that is not exactly the strict shape, without touching anything', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      const notifier = new FakeNotifier();
      for (const data of [null, {}, { ...m.payloads.recordatorio_24h, extra: 1 }, { ...m.payloads.recordatorio_24h, aviso: 'otro' }, { ...m.payloads.recordatorio_24h, referencia: 'xyz' }]) {
        expect(await ejecutarJobRecordatorio({ db, notifier }, data, 'job', enHoras(m, 24))).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
      }
      expect(notifier.enviados).toEqual([]);
    });
  });

  it('logs and messages carry ids and template names, never the piece text', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE producciones DISABLE TRIGGER producciones_before_update_delete');
      await db.query('UPDATE producciones SET texto_publicacion = $2 WHERE id = $1', [m.w.produccionId, SECRETO]);
      await db.query('UPDATE piezas SET idea = $2 WHERE id = $1', [m.w.piezaId, SECRETO]);
      const lines: string[] = [];
      const logger = pino({ level: 'trace' }, new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } }));
      const notifier = new FakeNotifier();
      await ejecutarJobRecordatorio({ db, notifier, logger }, m.payloads.recordatorio_24h, 'job', enHoras(m, 24));
      await ejecutarJobRecordatorio({ db, notifier, logger }, m.payloads.recordatorio_4h, 'job', new Date(m.plazo.getTime() + H));
      await db.query('DELETE FROM usuario_roles WHERE usuario_id = $1', [m.principal]);
      await ejecutarJobRecordatorio({ db, notifier, logger }, m.payloads.recordatorio_4h, 'job', enHoras(m, 4));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('')).not.toContain('secreto');
      expect(JSON.stringify(notifier.enviados)).not.toContain('secreto');
    });
  });

  it('a notifier that fails makes the job fail (no automatic retry), and nothing is recorded as sent', async () => {
    await withTestTransaction(async (db) => {
      const m = await mundo(db);
      const notifier = new FakeNotifier();
      notifier.fallarCon = new Error('proveedor caido');
      await expect(ejecutarJobRecordatorio({ db, notifier }, m.payloads.recordatorio_24h, 'job', enHoras(m, 24))).rejects.toThrow('proveedor caido');
      expect(notifier.enviados).toEqual([]);
    });
  });
});

