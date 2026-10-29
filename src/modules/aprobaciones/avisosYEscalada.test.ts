import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { afterAll, describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { getTestPool } from '../../../tests/utils/testPool.js';
import {
  createActores,
  createCliente,
  createPiezaAprobable,
  createProduccion,
  createUsuarioConRol,
  assignRole,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeNotifier } from '../../lib/notificaciones/notifiers.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { asClienteId } from '../shared/clienteId.js';
import { registrarDecision } from './aprobacionesService.js';
import {
  createPgBossRecordatorios,
  ejecutarJobEscalada,
  ESCALADA_QUEUE,
  RECORDATORIO_QUEUE,
  registerRecordatoriosJobs,
} from './recordatoriosJobs.js';
import { FakeRecordatorios, planificarAvisos, singletonKeyAviso, type ProgramarAvisosInput } from './recordatoriosPort.js';

const H = 3_600_000;

const input = (plazo: Date, zona = 'America/New_York'): ProgramarAvisosInput => ({
  clienteId: '11111111-1111-4111-8111-111111111111',
  tipo: 'pieza',
  objetoId: '22222222-2222-4222-8222-222222222222',
  plazo,
  zona,
  referencia: 'a'.repeat(64),
});

describe('planificarAvisos: what is queued for a deadline', () => {
  it('queues the three notices for a deadline far enough away, in order, each with its own key', () => {
    const plazo = new Date('2026-12-10T15:00:00Z');
    const avisos = planificarAvisos(input(plazo), new Date(plazo.getTime() - 48 * H));
    expect(avisos.map((a) => [a.aviso, plazo.getTime() - a.cuando.getTime()])).toEqual([
      ['recordatorio_24h', 24 * H],
      ['recordatorio_4h', 4 * H],
      ['turno_suplente', 2 * H],
    ]);
    expect(new Set(avisos.map((a) => a.singletonKey)).size).toBe(3);
    expect(avisos.every((a) => a.singletonKey === singletonKeyAviso(a.payload))).toBe(true);
  });

  it('a deadline too close drops the notices already due: only what is still ahead is queued', () => {
    const plazo = new Date('2026-12-10T15:00:00Z');
    const at = (horas: number) => planificarAvisos(input(plazo), new Date(plazo.getTime() - horas * H)).map((a) => a.aviso);
    expect(at(10)).toEqual(['recordatorio_4h', 'turno_suplente']);
    expect(at(3)).toEqual(['turno_suplente']);
    expect(at(1)).toEqual([]);
    expect(at(-1)).toEqual([]);
  });

  it('across a US daylight-saving change the instants are exact elapsed hours', () => {
    for (const [plazoIso, zona] of [['2027-03-14T14:00:00Z', 'America/New_York'], ['2026-11-01T15:00:00Z', 'America/New_York'], ['2027-03-14T17:00:00Z', 'America/Los_Angeles']] as const) {
      const plazo = new Date(plazoIso);
      const avisos = planificarAvisos(input(plazo, zona), new Date(plazo.getTime() - 48 * H));
      expect(avisos.map((a) => plazo.getTime() - a.cuando.getTime())).toEqual([24 * H, 4 * H, 2 * H]);
    }
  });

  it('the same input gives the same keys, and another deadline or another hash gives other keys', () => {
    const plazo = new Date('2026-12-10T15:00:00Z');
    const keys = (i: ProgramarAvisosInput) => planificarAvisos(i, new Date(plazo.getTime() - 48 * H)).map((a) => a.singletonKey);
    expect(keys(input(plazo))).toEqual(keys(input(plazo)));
    expect(keys(input(new Date(plazo.getTime() + H)))).not.toEqual(keys(input(plazo)));
    expect(keys({ ...input(plazo), referencia: 'b'.repeat(64) })).not.toEqual(keys(input(plazo)));
  });
});

describe('escalation on the 3rd client change request', () => {
  async function mundoEscalable(db: Db) {
    const w = await createPiezaAprobable(db, new FakeStorage());
    const actores = await createActores(db, w.clienteId);
    return { w, actores, clienteId: asClienteId(w.clienteId) };
  }

  /** Internal approval, client change request, NovaCiel takes it back and produces the next version. */
  async function ronda(db: Db, x: Awaited<ReturnType<typeof mundoEscalable>>, recordatorios: FakeRecordatorios, nivelCambios: 'cliente' | 'interno') {
    const hash = (await db.query<{ h: string }>(`SELECT encode(hash_pieza, 'hex') AS h FROM producciones WHERE pieza_id = $1 AND es_actual`, [x.w.piezaId])).rows[0]!.h;
    if (nivelCambios === 'interno') {
      await registrarDecision({ db, recordatorios }, x.clienteId, x.w.piezaId, x.actores.novaciel, { nivel: 'interno', decision: 'cambios', hashVisto: hash, motivo: 'toma' });
      await transitionPieza(db, x.clienteId, x.w.piezaId, 'en_produccion', { tipo: 'sistema' });
    } else {
      await registrarDecision({ db, recordatorios }, x.clienteId, x.w.piezaId, x.actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: hash });
      await registrarDecision({ db, recordatorios }, x.clienteId, x.w.piezaId, x.actores.cliente, { nivel: 'cliente', decision: 'cambios', hashVisto: hash, motivo: 'texto' });
      await transitionPieza(db, x.clienteId, x.w.piezaId, 'en_produccion', { tipo: 'sistema' });
    }
    await createProduccion(db, { piezaId: x.w.piezaId });
    await transitionPieza(db, x.clienteId, x.w.piezaId, 'en_control_calidad', { tipo: 'sistema' });
    await transitionPieza(db, x.clienteId, x.w.piezaId, 'revision_novaciel', { tipo: 'sistema' });
  }

  it('the 1st and 2nd request notify nobody, the 3rd queues one escalation, the 4th does not', async () => {
    await withTestTransaction(async (db) => {
      const x = await mundoEscalable(db);
      const recordatorios = new FakeRecordatorios();
      const seen: number[] = [];
      for (let i = 1; i <= 4; i++) {
        await ronda(db, x, recordatorios, 'cliente');
        seen.push(recordatorios.escaladas.length);
      }
      expect(seen).toEqual([0, 0, 1, 1]);
      expect(recordatorios.escaladas[0]).toEqual({ clienteId: x.w.clienteId, piezaId: x.w.piezaId });
    });
  });

  it('internal change requests never trigger it, however many there are', async () => {
    await withTestTransaction(async (db) => {
      const x = await mundoEscalable(db);
      const recordatorios = new FakeRecordatorios();
      for (let i = 0; i < 4; i++) await ronda(db, x, recordatorios, 'interno');
      expect(recordatorios.escaladas).toEqual([]);
    });
  });

  it('the escalation job tells every active NovaCiel administrator and operator, and only them', async () => {
    await withTestTransaction(async (db) => {
      const x = await mundoEscalable(db);
      const recordatorios = new FakeRecordatorios();
      for (let i = 0; i < 3; i++) await ronda(db, x, recordatorios, 'cliente');
      const operador = await createUsuarioConRol(db, 'operador_novaciel');
      const inactivo = await createUsuarioConRol(db, 'operador_novaciel');
      await db.query('UPDATE usuarios SET activo = false WHERE id = $1', [inactivo.id]);
      const notifier = new FakeNotifier();
      const salida = await ejecutarJobEscalada({ db, notifier }, recordatorios.escaladas[0], 'job');
      const personal = (await db.query<{ id: string }>(`SELECT DISTINCT u.id FROM usuarios u JOIN usuario_roles ur ON ur.usuario_id = u.id WHERE u.activo AND ur.ambito = 'novaciel'`)).rows.map((r) => r.id).sort();
      expect(personal).toEqual(expect.arrayContaining([x.actores.ids.novaciel, operador.id]));
      expect(personal).not.toContain(inactivo.id);
      expect(salida).toEqual({ resultado: 'enviado', plantilla: 'escalada_cambios', destinatarios: personal.length });
      expect(notifier.enviados.map((e) => e.destinatarioUsuarioId).sort()).toEqual(personal);
      expect(notifier.enviados.every((e) => e.plantilla === 'escalada_cambios' && e.clienteId === x.w.clienteId && e.referencia.id === x.w.piezaId)).toBe(true);
      expect(notifier.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(x.actores.ids.cliente);
    });
  });

  it('the job does nothing for a piece that is not past the allowed rounds, for another client, or for a bad payload', async () => {
    await withTestTransaction(async (db) => {
      const x = await mundoEscalable(db);
      const recordatorios = new FakeRecordatorios();
      await ronda(db, x, recordatorios, 'cliente');
      const notifier = new FakeNotifier();
      expect(await ejecutarJobEscalada({ db, notifier }, { clienteId: x.w.clienteId, piezaId: x.w.piezaId }, 'job')).toEqual({ resultado: 'omitido', codigo: 'no_escalada' });
      const other = await createCliente(db);
      expect(await ejecutarJobEscalada({ db, notifier }, { clienteId: other.id, piezaId: x.w.piezaId }, 'job')).toEqual({ resultado: 'omitido', codigo: 'objeto_no_encontrado' });
      expect(await ejecutarJobEscalada({ db, notifier }, { clienteId: x.w.clienteId }, 'job')).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
      expect(notifier.enviados).toEqual([]);
    });
  });

  it('a client approver who is also given a NovaCiel role is told as staff (the role decides), a plain client user never', async () => {
    await withTestTransaction(async (db) => {
      const x = await mundoEscalable(db);
      const recordatorios = new FakeRecordatorios();
      for (let i = 0; i < 3; i++) await ronda(db, x, recordatorios, 'cliente');
      const colaborador = await createUsuarioConRol(db, 'colaborador_cliente', x.w.clienteId);
      const notifier = new FakeNotifier();
      await ejecutarJobEscalada({ db, notifier }, recordatorios.escaladas[0], 'job');
      expect(notifier.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(colaborador.id);
      await assignRole(db, { usuarioId: colaborador.id, rolCodigo: 'operador_novaciel' });
      const again = new FakeNotifier();
      await ejecutarJobEscalada({ db, notifier: again }, recordatorios.escaladas[0], 'job');
      expect(again.enviados.map((e) => e.destinatarioUsuarioId)).toContain(colaborador.id);
    });
  });
});

// ---- The real pg-boss, against the test database, in a schema of its own that the tests drop. ----------

describe('the real pg-boss port', () => {
  const SCHEMA = 'pgboss_aprobaciones_test';
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: SCHEMA });
  boss.on('error', () => undefined);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await getTestPool().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });

  const plazo = () => new Date(Date.now() + 7 * 24 * H);
  const nuevoInput = (): ProgramarAvisosInput => ({ ...input(plazo()), clienteId: randomUUID(), objetoId: randomUUID() });
  const jobsDe = async (queue: string, key: string) => boss.findJobs(queue, { key });

  async function enTransaccion<T>(fn: (tx: Db) => Promise<T>, commit: boolean): Promise<T> {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } finally {
      client.release();
    }
  }

  it('queues one job per notice with its start time, and never twice for the same approval target', async () => {
    await boss.start();
    await boss.createQueue(RECORDATORIO_QUEUE, { policy: 'exclusive', retryLimit: 0 });
    await boss.createQueue(ESCALADA_QUEUE, { policy: 'exclusive', retryLimit: 0 });
    const puerto = createPgBossRecordatorios(boss);
    const entrada = nuevoInput();
    const esperados = planificarAvisos(entrada, new Date());

    const primera = await enTransaccion((tx) => puerto.programar(tx, entrada), true);
    expect(primera).toEqual(['recordatorio_24h', 'recordatorio_4h', 'turno_suplente']);
    const segunda = await enTransaccion((tx) => puerto.programar(tx, entrada), true);
    expect(segunda).toEqual(primera); // asked again: the same notices, no new jobs

    for (const aviso of esperados) {
      const jobs = await jobsDe(RECORDATORIO_QUEUE, aviso.singletonKey);
      expect(jobs, aviso.aviso).toHaveLength(1);
      expect(jobs[0]!.data).toEqual(aviso.payload);
      expect(Math.abs(new Date(jobs[0]!.startAfter).getTime() - aviso.cuando.getTime())).toBeLessThan(1500);
    }
  });

  it('is atomic with the caller: a rolled-back transaction leaves no job behind', async () => {
    const puerto = createPgBossRecordatorios(boss);
    const entrada = nuevoInput();
    await enTransaccion((tx) => puerto.programar(tx, entrada), false);
    await enTransaccion((tx) => puerto.escalar(tx, { clienteId: entrada.clienteId, piezaId: entrada.objetoId }), false);
    for (const aviso of planificarAvisos(entrada, new Date())) expect(await jobsDe(RECORDATORIO_QUEUE, aviso.singletonKey)).toHaveLength(0);
    expect(await jobsDe(ESCALADA_QUEUE, `${entrada.clienteId}:${entrada.objetoId}:escalada`)).toHaveLength(0);
  });

  it('queues the escalation once, however many times it is asked', async () => {
    const puerto = createPgBossRecordatorios(boss);
    const datos = { clienteId: randomUUID(), piezaId: randomUUID() };
    await enTransaccion((tx) => puerto.escalar(tx, datos), true);
    await enTransaccion((tx) => puerto.escalar(tx, datos), true);
    expect(await jobsDe(ESCALADA_QUEUE, `${datos.clienteId}:${datos.piezaId}:escalada`)).toHaveLength(1);
  });

  it('a deadline too close queues only what is still ahead (nothing for a deadline in the past)', async () => {
    const puerto = createPgBossRecordatorios(boss);
    const cerca = { ...nuevoInput(), plazo: new Date(Date.now() + 3 * H) };
    expect(await enTransaccion((tx) => puerto.programar(tx, cerca), true)).toEqual(['turno_suplente']);
    const pasado = { ...nuevoInput(), plazo: new Date(Date.now() - H) };
    expect(await enTransaccion((tx) => puerto.programar(tx, pasado), true)).toEqual([]);
  });

  it('the workers are registered and run a due job through the job function (here a stale one: a no-op)', async () => {
    await registerRecordatoriosJobs(boss, { db: getTestPool(), notifier: new FakeNotifier() });
    const payload = { ...planificarAvisos(nuevoInput(), new Date())[0]!.payload };
    const id = await boss.send(RECORDATORIO_QUEUE, payload, { singletonKey: `due:${payload.objetoId}` });
    const deadline = Date.now() + 20_000;
    let job = await boss.getJobById(RECORDATORIO_QUEUE, id!);
    while (Date.now() < deadline && job?.state !== 'completed' && job?.state !== 'failed') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      job = await boss.getJobById(RECORDATORIO_QUEUE, id!);
    }
    expect(job?.state).toBe('completed');
    expect(job?.output).toEqual({ resultado: 'omitido', codigo: 'objeto_no_encontrado' });
  }, 40_000);
});
