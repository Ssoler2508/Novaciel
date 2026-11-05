import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPiezaProgramada, type PiezaProgramada } from '../../../tests/utils/publicacionWorld.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import {
  createActores,
  createConexionRed,
  createPiezaAprobable,
  createPublicacion,
  createPublicacionResultado,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { FakeNotifier } from '../../lib/notificaciones/notifiers.js';
import { FakePublishProvider } from '../../lib/publish/fakePublishProvider.js';
import { PublishProviderError } from '../../lib/publish/types.js';
import { registrarDecision } from '../aprobaciones/aprobacionesService.js';
import { FakeRecordatorios } from '../aprobaciones/recordatoriosPort.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { asClienteId } from '../shared/clienteId.js';
import { claveIdempotencia } from './claveIdempotencia.js';
import {
  ejecutarBarrido,
  ejecutarJobPublicar,
  ejecutarRecoleccionMetricas,
  GRACIA_JOB_PERDIDO_MS,
  GRACIA_REINTENTO_PERDIDO_MS,
  type PublicacionesJobDeps,
} from './publicacionesJobs.js';
import { FakePublicacionQueue, singletonKeyPublicar, type PayloadPublicar } from './publicacionQueue.js';
import { LIMITE_REPROGRAMACIONES_AUTOMATICAS, MINIMO_HORAS_REPROGRAMACION } from './reglasProgramacion.js';

// The job functions are called directly with a given "now", like the reminder jobs. pg-boss itself is not
// started here; the registration only wires these functions (and is checked by workersGuard.test.ts).

const fetchMock = vi.fn(() => {
  throw new Error('network access is forbidden in tests');
});
beforeEach(() => void vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const H = 3_600_000;
const MIN = 60_000;

function armar(db: Db, p: { storage: FakeStorage }, provider = new FakePublishProvider()) {
  const queue = new FakePublicacionQueue();
  const recordatorios = new FakeRecordatorios();
  const log = createLogger('debug', { write: () => undefined });
  const deps: PublicacionesJobDeps = {
    db,
    storage: p.storage,
    provider,
    queue,
    recordatorios,
    alertas: { db, notifier: new FakeNotifier(), logger: log },
    logger: log,
    random: () => 0.5,
  };
  return { deps, queue, provider, recordatorios };
}

async function payloadDe(db: Db, p: PiezaProgramada, ronda = 0): Promise<PayloadPublicar> {
  const pieza = (await getPieza(db, p.clienteId, p.w.piezaId))!;
  return { clienteId: p.w.clienteId, piezaId: p.w.piezaId, produccionId: p.w.produccionId, fechaHora: pieza.fecha_hora.toISOString(), ronda };
}
const alertas = async (db: Db, clienteId: string) => (await db.query<{ codigo: string }>('SELECT codigo FROM alertas WHERE cliente_id = $1 ORDER BY creado_en', [clienteId])).rows.map((r) => r.codigo);
const estado = async (db: Db, p: { clienteId: ReturnType<typeof asClienteId>; w: { piezaId: string } }) => (await getPieza(db, p.clienteId, p.w.piezaId))!.estado;

describe('the scheduled send job', () => {
  it('sends the piece at its time, once: a second run of the same job finds it published and does nothing', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const { deps, provider } = armar(db, p);
      const payload = await payloadDe(db, p);
      const ahora = new Date(payload.fechaHora);
      expect(await ejecutarJobPublicar(deps, payload, ahora)).toMatchObject({ resultado: 'publicada', intento: 1 });
      expect(await ejecutarJobPublicar(deps, payload, ahora)).toEqual({ resultado: 'obsoleto' });
      expect(provider.publishCalls).toBe(1);
      expect(await estado(db, p)).toBe('publicada');
    });
  });

  it('the singleton key is per piece, production, scheduled time and round', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const a = await payloadDe(db, p);
      expect(singletonKeyPublicar(a)).toBe(singletonKeyPublicar({ ...a }));
      expect(singletonKeyPublicar(a)).not.toBe(singletonKeyPublicar({ ...a, ronda: 1 }));
      expect(singletonKeyPublicar(a)).not.toBe(singletonKeyPublicar({ ...a, fechaHora: new Date(Date.parse(a.fechaHora) + MIN).toISOString() }));
      expect(singletonKeyPublicar(a)).not.toBe(singletonKeyPublicar({ ...a, produccionId: '00000000-0000-4000-8000-000000000000' }));
    });
  });

  it('a job queued for an old time does nothing after a reschedule, a cancel or a failure state', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const { deps, provider } = armar(db, p);
      const viejo = await payloadDe(db, p);
      await db.query(`UPDATE piezas SET fecha_hora = now() + interval '3 days' WHERE id = $1`, [p.w.piezaId]);
      expect(await ejecutarJobPublicar(deps, viejo, new Date(Date.now() + 4 * 24 * H))).toEqual({ resultado: 'obsoleto' });
      await db.query(`UPDATE piezas SET fecha_hora = now() - interval '1 minute' WHERE id = $1`, [p.w.piezaId]);
      const actual = await payloadDe(db, p);
      await transitionPieza(db, p.clienteId, p.w.piezaId, 'con_cambios', { tipo: 'sistema' }, { motivo: 'cancelada' });
      expect(await ejecutarJobPublicar(deps, actual, new Date())).toEqual({ resultado: 'obsoleto' });
      expect(provider.calls).toEqual([]);
    });
  });

  it('a transient failure queues the retry job with its own wait and round; running it publishes', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const { deps, queue, provider } = armar(db, p, new FakePublishProvider().scriptPublish({ fail: 'server' }));
      const payload = await payloadDe(db, p);
      const ahora = new Date(Date.now() + MIN);
      const r1 = await ejecutarJobPublicar(deps, payload, ahora);
      expect(r1).toEqual({ resultado: 'reintento_encolado', ronda: 1, esperaMs: 30_000 });
      expect(queue.reencolados).toHaveLength(1);
      expect(queue.reencolados[0]!.payload).toEqual({ ...payload, ronda: 1 });
      expect(queue.reencolados[0]!.cuando.getTime()).toBe(ahora.getTime() + 30_000);
      // The retry has a different key than the scheduled job, so the queue accepts it while the first is still active.
      expect(singletonKeyPublicar(queue.reencolados[0]!.payload)).not.toBe(singletonKeyPublicar(payload));

      const r2 = await ejecutarJobPublicar(deps, queue.reencolados[0]!.payload, queue.reencolados[0]!.cuando);
      expect(r2).toMatchObject({ resultado: 'publicada', intento: 2 });
      expect(provider.posts).toBe(1);
    });
  });

  it('retries are bounded: the third transient failure is final, no fourth job', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const { deps, queue } = armar(db, p, new FakePublishProvider().scriptPublish({ fail: 'server' }, { fail: 'timeout' }, { fail: 'server' }));
      let payload = await payloadDe(db, p);
      let ahora = new Date(Date.now() + MIN);
      const salidas = [];
      for (let i = 0; i < 3; i++) {
        salidas.push((await ejecutarJobPublicar(deps, payload, ahora)).resultado);
        if (queue.reencolados[i]) {
          payload = queue.reencolados[i]!.payload;
          ahora = queue.reencolados[i]!.cuando;
        }
      }
      expect(salidas).toEqual(['reintento_encolado', 'reintento_encolado', 'fallida']);
      expect(queue.reencolados).toHaveLength(2);
      expect(await estado(db, p)).toBe('fallo_publicacion');
    });
  });

  it('a refusal by the gate is a normal answer of the job (the service already moved the piece and alerted), not a failed job', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const { deps, provider } = armar(db, p);
      await p.storage.put(p.w.claves[0]!, Buffer.from('alterado'), 'image/jpeg');
      const payload = await payloadDe(db, p);
      expect(await ejecutarJobPublicar(deps, payload, new Date())).toEqual({ resultado: 'bloqueada', motivo: 'ArchivoAlteradoError' });
      expect(provider.calls).toEqual([]);
      expect(await estado(db, p)).toBe('fallo_publicacion');
      expect(await alertas(db, p.w.clienteId)).toEqual(['publicacion_fallida']);
    });
  });

  it('a malformed payload fails the job (so withFailureAlert raises trabajo_fallido)', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const { deps } = armar(db, p);
      await expect(ejecutarJobPublicar(deps, { clienteId: 'no', texto: 'x' }, new Date())).rejects.toThrow();
    });
  });
});

describe('the sweep: a piece without approval at its scheduled time', () => {
  /** A piece that waits for the client (or, with `soloInterno: false`, for the internal level) whose time has come. */
  async function esperando(db: Db, nivel: 'interno' | 'cliente') {
    const storage = new FakeStorage();
    const w = await createPiezaAprobable(db, storage);
    const actores = await createActores(db, w.clienteId);
    const clienteId = asClienteId(w.clienteId);
    if (nivel === 'cliente') await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
    await db.query(`UPDATE piezas SET fecha_hora = now() - interval '1 minute' WHERE id = $1`, [w.piezaId]);
    return { w, clienteId, storage };
  }

  it('is never published: it moves to the next allowed slot at least 24 h ahead, the reminders are queued again and NovaCiel is alerted', async () => {
    await withTestTransaction(async (db) => {
      const x = await esperando(db, 'cliente');
      await createConexionRed(db, { clienteId: x.w.clienteId, red: 'instagram' });
      const { deps, provider, recordatorios } = armar(db, x);
      const ahora = new Date(Date.now() + MIN);
      const salida = await ejecutarBarrido(deps, ahora);
      expect(salida.sinAprobacion).toEqual({ reprogramadas: 1, agotadas: 0 });
      const pieza = (await getPieza(db, x.clienteId, x.w.piezaId))!;
      expect(pieza.estado).toBe('esperando_aprobacion');
      expect(pieza.fecha_hora.getTime()).toBeGreaterThanOrEqual(ahora.getTime() + MINIMO_HORAS_REPROGRAMACION * H);
      expect(recordatorios.programados).toHaveLength(1);
      expect(recordatorios.programados[0]!.input.plazo.getTime()).toBe(pieza.fecha_hora.getTime());
      expect(provider.calls).toEqual([]);
      expect(await alertas(db, x.w.clienteId)).toEqual(['publicacion_sin_aprobacion']);
      const audit = await db.query(`SELECT 1 FROM auditoria WHERE accion = 'reprogramar_sin_aprobacion' AND fila_id = $1`, [x.w.piezaId]);
      expect(audit.rows).toHaveLength(1);
      // Running the sweep again in the same minute changes nothing: the new time is in the future.
      expect((await ejecutarBarrido(deps, ahora)).sinAprobacion).toEqual({ reprogramadas: 0, agotadas: 0 });
    });
  });

  it('a piece still in the internal review is also rescheduled, without queueing client reminders', async () => {
    await withTestTransaction(async (db) => {
      const x = await esperando(db, 'interno');
      const { deps, recordatorios } = armar(db, x);
      const salida = await ejecutarBarrido(deps, new Date(Date.now() + MIN));
      expect(salida.sinAprobacion.reprogramadas).toBe(1);
      expect(recordatorios.programados).toEqual([]);
    });
  });

  it('after 3 automatic reschedules in a row it stops and raises the critical alert once', async () => {
    await withTestTransaction(async (db) => {
      const x = await esperando(db, 'cliente');
      const { deps } = armar(db, x);
      let ahora = new Date(Date.now() + MIN);
      for (let i = 1; i <= LIMITE_REPROGRAMACIONES_AUTOMATICAS; i++) {
        expect((await ejecutarBarrido(deps, ahora)).sinAprobacion.reprogramadas).toBe(1);
        ahora = new Date((await getPieza(db, x.clienteId, x.w.piezaId))!.fecha_hora.getTime() + MIN);
      }
      expect((await ejecutarBarrido(deps, ahora)).sinAprobacion).toEqual({ reprogramadas: 0, agotadas: 1 });
      expect((await ejecutarBarrido(deps, ahora)).sinAprobacion).toEqual({ reprogramadas: 0, agotadas: 1 });
      const codigos = await alertas(db, x.w.clienteId);
      expect(codigos.filter((c) => c === 'publicacion_sin_aprobacion')).toHaveLength(3);
      expect(codigos.filter((c) => c === 'publicacion_reprogramaciones_agotadas')).toHaveLength(1);
    });
  });

  it('only touches pieces of approved plans that are really waiting, each in its own client', async () => {
    await withTestTransaction(async (db) => {
      const a = await esperando(db, 'cliente');
      const b = await esperando(db, 'cliente');
      await db.query(`UPDATE piezas SET fecha_hora = now() + interval '5 days' WHERE id = $1`, [b.w.piezaId]);
      const { deps } = armar(db, a);
      const salida = await ejecutarBarrido(deps, new Date(Date.now() + MIN));
      expect(salida.sinAprobacion.reprogramadas).toBe(1);
      expect(await alertas(db, b.w.clienteId)).toEqual([]);
      expect((await getPieza(db, b.clienteId, b.w.piezaId))!.fecha_hora.getTime()).toBeGreaterThan(Date.now() + 4 * 24 * H);
    });
  });
});

describe('the sweep: the safety net for the send', () => {
  it('queues the send again only when the scheduled job is overdue by the grace period', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const { deps, queue } = armar(db, p);
      const pieza = (await getPieza(db, p.clienteId, p.w.piezaId))!;
      const antes = new Date(pieza.fecha_hora.getTime() + GRACIA_JOB_PERDIDO_MS - 1000);
      expect((await ejecutarBarrido(deps, antes)).reencoladas).toBe(0);
      const despues = new Date(pieza.fecha_hora.getTime() + GRACIA_JOB_PERDIDO_MS);
      expect((await ejecutarBarrido(deps, despues)).reencoladas).toBe(1);
      expect(queue.reencolados[0]!.payload).toEqual({ ...(await payloadDe(db, p)), ronda: 0 });
    });
  });

  it('queues a lost retry only after its grace period, with the round of the failed attempt', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const { deps, queue } = armar(db, p);
      const clave = claveIdempotencia({ piezaId: p.w.piezaId, produccionId: p.w.produccionId, hashPieza: p.w.hashPieza });
      const a = await createPublicacion(db, { piezaId: p.w.piezaId, claveIdempotencia: clave });
      await createPublicacionResultado(db, { publicacionId: a.id, estado: 'fallida', categoriaError: 'server' });
      const fallo = (await db.query<{ t: Date }>('SELECT creado_en AS t FROM publicaciones_resultados WHERE publicacion_id = $1', [a.id])).rows[0]!.t;
      expect((await ejecutarBarrido(deps, new Date(fallo.getTime() + GRACIA_REINTENTO_PERDIDO_MS - 1000))).reencoladas).toBe(0);
      expect((await ejecutarBarrido(deps, new Date(fallo.getTime() + GRACIA_REINTENTO_PERDIDO_MS))).reencoladas).toBe(1);
      expect(queue.reencolados[0]!.payload.ronda).toBe(1);
    });
  });

  it('leaves alone a piece whose attempt is in flight or of unknown outcome', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const { deps } = armar(db, p);
      const clave = claveIdempotencia({ piezaId: p.w.piezaId, produccionId: p.w.produccionId, hashPieza: p.w.hashPieza });
      await createPublicacion(db, { piezaId: p.w.piezaId, claveIdempotencia: clave });
      expect((await ejecutarBarrido(deps, new Date(Date.now() + 5 * H))).reencoladas).toBe(0);
    });
  });
});

describe('the metrics collection', () => {
  async function publicada(db: Db) {
    const p = await createPiezaProgramada(db);
    const ctx = armar(db, p);
    await ejecutarJobPublicar(ctx.deps, await payloadDe(db, p), new Date());
    expect(await estado(db, p)).toBe('publicada');
    return { p, ...ctx };
  }
  const snapshots = async (db: Db, piezaId: string) =>
    (await db.query<{ ventana: string; alcance: string | null }>(
      `SELECT m.ventana, m.alcance FROM metricas_pieza m JOIN publicaciones p ON p.id = m.publicacion_id
       WHERE p.pieza_id = $1 ORDER BY array_position(ARRAY['24h', '72h', '7d', '28d'], m.ventana)`,
      [piezaId],
    )).rows;

  it('collects each window only when it is due, once, and moves the piece to en_medicion and then cerrada', async () => {
    await withTestTransaction(async (db) => {
      const { p, deps, provider } = await publicada(db);
      const t0 = Date.now();
      expect(await ejecutarRecoleccionMetricas(deps, new Date(t0 + 23 * H))).toEqual({ recogidas: 0, fallidas: 0 });
      expect(await ejecutarRecoleccionMetricas(deps, new Date(t0 + 25 * H))).toEqual({ recogidas: 1, fallidas: 0 });
      expect((await snapshots(db, p.w.piezaId)).map((s) => s.ventana)).toEqual(['24h']);
      expect(await estado(db, p)).toBe('en_medicion');
      // The same moment again: nothing is due that was not taken.
      expect(await ejecutarRecoleccionMetricas(deps, new Date(t0 + 25 * H))).toEqual({ recogidas: 0, fallidas: 0 });
      expect(await ejecutarRecoleccionMetricas(deps, new Date(t0 + 73 * H))).toMatchObject({ recogidas: 1 });
      expect(await ejecutarRecoleccionMetricas(deps, new Date(t0 + 29 * 24 * H))).toMatchObject({ recogidas: 2 });
      expect((await snapshots(db, p.w.piezaId)).map((s) => s.ventana)).toEqual(['24h', '72h', '7d', '28d']);
      expect(await estado(db, p)).toBe('cerrada');
      expect(provider.calls.filter((c) => c.op === 'getMetrics')).toHaveLength(4);
      expect((await snapshots(db, p.w.piezaId))[0]!.alcance).not.toBeNull();
      // Closed: no more collection.
      expect(await ejecutarRecoleccionMetricas(deps, new Date(t0 + 60 * 24 * H))).toEqual({ recogidas: 0, fallidas: 0 });
    });
  });

  it('a provider failure leaves the window pending for the next run, with no snapshot and no leaked message', async () => {
    await withTestTransaction(async (db) => {
      const { p, deps, provider } = await publicada(db);
      vi.spyOn(provider, 'getMetrics').mockRejectedValueOnce(new PublishProviderError('server', 500));
      const ahora = new Date(Date.now() + 25 * H);
      expect(await ejecutarRecoleccionMetricas(deps, ahora)).toEqual({ recogidas: 0, fallidas: 1 });
      expect(await snapshots(db, p.w.piezaId)).toEqual([]);
      expect(await ejecutarRecoleccionMetricas(deps, ahora)).toEqual({ recogidas: 1, fallidas: 0 });
    });
  });

  it('an auth failure raises conexion_red_vencida; a revoked connection too', async () => {
    await withTestTransaction(async (db) => {
      const { p, deps, provider } = await publicada(db);
      vi.spyOn(provider, 'getMetrics').mockRejectedValueOnce(new PublishProviderError('auth', 401));
      const ahora = new Date(Date.now() + 25 * H);
      expect((await ejecutarRecoleccionMetricas(deps, ahora)).fallidas).toBe(1);
      expect(await alertas(db, p.w.clienteId)).toContain('conexion_red_vencida');
      await db.query('UPDATE conexiones_redes SET revocada_en = now() WHERE cliente_id = $1', [p.w.clienteId]);
      expect(await ejecutarRecoleccionMetricas(deps, ahora)).toEqual({ recogidas: 0, fallidas: 1 });
    });
  });

  it('does not collect for a piece that was never published, and keeps each client apart', async () => {
    await withTestTransaction(async (db) => {
      const a = await publicada(db);
      const b = await createPiezaProgramada(db); // programada, not published
      const salida = await ejecutarRecoleccionMetricas(a.deps, new Date(Date.now() + 25 * H));
      expect(salida.recogidas).toBe(1);
      expect(await snapshots(db, b.w.piezaId)).toEqual([]);
      expect((await snapshots(db, a.p.w.piezaId)).length).toBe(1);
    });
  });
});
