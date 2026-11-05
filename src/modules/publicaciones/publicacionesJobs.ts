import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { runInTransaction } from '../../db/transaction.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { PublishProviderError, type PublishContext } from '../../lib/publish/types.js';
import { raiseAlertBestEffort } from '../alertas/raiseAlert.js';
import { withFailureAlert } from '../alertas/withFailureAlert.js';
import type { Recordatorios } from '../aprobaciones/recordatoriosPort.js';
import { getSecretForUse } from '../conexionesRedes/conexionesRedesRepository.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { lockPlanYPieza, transitionPieza } from '../piezas/piezasService.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import {
  ArchivoAlteradoAlEnviarError,
  ConexionNoDisponibleError,
  EtiquetaIaNoSoportadaError,
  PiezaEstadoProgramacionError,
  PublicacionAgotadaError,
  PublicacionPrematuraError,
} from './errors.js';
import {
  insertMetricas,
  listMedicionesPendientes,
  listPiezasVencidasSinAprobacion,
  listProgramadasVencidas,
} from './medicionRepository.js';
import { getConexionActiva } from './publicacionesRepository.js';
import {
  BARRIDO_CRON,
  BARRIDO_QUEUE,
  crearColasPublicacion,
  METRICAS_CRON,
  METRICAS_QUEUE,
  payloadPublicarSchema,
  PUBLICAR_QUEUE,
  type PayloadPublicar,
  type PublicacionQueue,
} from './publicacionQueue.js';
import { esFalloDeCompuerta, publicarPieza, type PublicacionDeps } from './publicacionService.js';
import { reprogramarSinAprobacion } from './sinAprobacionService.js';

// The jobs of publishing (Step 10, checkpoint D). Like the reminders of Step 9, every job re-checks the state
// when it fires and does nothing if the piece, its production or its scheduled time changed: a reschedule or a
// cancel needs no cancel logic, the stale job simply finishes as a no-op. pg-boss never retries a job by itself
// (retryLimit 0): the bounded retries of the retry policy are NEW jobs queued with their own wait.
// Logs and outputs carry ids and codes only.

export interface PublicacionesJobDeps extends PublicacionDeps {
  queue: PublicacionQueue;
  recordatorios?: Recordatorios;
}

/** A programada piece whose scheduled job never ran is picked up by the sweep after this much (VERIFY). */
export const GRACIA_JOB_PERDIDO_MS = 2 * 60_000;
/** A failed attempt whose retry job never ran (a crash between the result and the queueing) is retried after this much (VERIFY). */
export const GRACIA_REINTENTO_PERDIDO_MS = 15 * 60_000;

export type SalidaPublicar =
  | { resultado: 'obsoleto' }
  | { resultado: 'publicada'; intento: number; yaEstabaPublicada: boolean }
  | { resultado: 'en_curso' }
  | { resultado: 'reintento_encolado'; ronda: number; esperaMs: number }
  | { resultado: 'desconocida'; agotada: boolean }
  | { resultado: 'fallida'; categoria: string }
  /** The gate or a precondition refused the send. The piece was moved and the alert raised by the service. */
  | { resultado: 'bloqueada'; motivo: string };

function bloqueo(error: unknown): string | null {
  if (
    error instanceof PiezaEstadoProgramacionError ||
    error instanceof PublicacionPrematuraError ||
    error instanceof ConexionNoDisponibleError ||
    error instanceof EtiquetaIaNoSoportadaError ||
    error instanceof ArchivoAlteradoAlEnviarError ||
    error instanceof PublicacionAgotadaError ||
    esFalloDeCompuerta(error)
  ) {
    return (error as Error).name;
  }
  return null;
}

/** The scheduled send (and its retries). `ahora` is injectable so tests can fire it at any time. */
export async function ejecutarJobPublicar(deps: PublicacionesJobDeps, data: unknown, ahora: Date = new Date()): Promise<SalidaPublicar> {
  const p = payloadPublicarSchema.parse(data);
  const clienteId = asClienteId(p.clienteId);
  const pieza = await getPieza(deps.db, clienteId, p.piezaId);
  // The piece moved on (cancelled, rescheduled, published, in failure) or its time is not the one this job was queued for.
  if (!pieza || pieza.estado !== 'programada' || pieza.fecha_hora.getTime() !== Date.parse(p.fechaHora)) return { resultado: 'obsoleto' };

  let r;
  try {
    r = await publicarPieza({ ...deps, now: () => ahora }, clienteId, p.piezaId, { tipo: 'sistema' });
  } catch (error) {
    const motivo = bloqueo(error);
    if (motivo === null) throw error;
    return { resultado: 'bloqueada', motivo };
  }
  switch (r.estado) {
    case 'publicada':
      return { resultado: 'publicada', intento: r.intento, yaEstabaPublicada: r.yaEstabaPublicada };
    case 'en_curso':
      return { resultado: 'en_curso' };
    case 'desconocida':
      return { resultado: 'desconocida', agotada: r.agotada };
    case 'fallida':
      return { resultado: 'fallida', categoria: r.categoria };
    case 'reintento': {
      const siguiente: PayloadPublicar = { ...p, ronda: r.intento };
      await deps.queue.reencolar(siguiente, new Date(ahora.getTime() + r.esperaMs));
      return { resultado: 'reintento_encolado', ronda: siguiente.ronda, esperaMs: r.esperaMs };
    }
  }
}

export interface SalidaBarrido {
  sinAprobacion: { reprogramadas: number; agotadas: number };
  /** Send jobs queued again because the scheduled one (or a retry) never ran. */
  reencoladas: number;
}

/**
 * The minute sweep. (1) Pieces still waiting for approval when their time came are rescheduled (never
 * published). (2) The safety net: `programada` pieces that are due and whose scheduled job or retry job never ran
 * get their send queued again (the singleton key keeps it from duplicating a job that does exist).
 */
export async function ejecutarBarrido(deps: PublicacionesJobDeps, ahora: Date = new Date()): Promise<SalidaBarrido> {
  const log = deps.logger ?? defaultLogger;
  const salida: SalidaBarrido = { sinAprobacion: { reprogramadas: 0, agotadas: 0 }, reencoladas: 0 };

  for (const v of await listPiezasVencidasSinAprobacion(deps.db, ahora)) {
    const r = await reprogramarSinAprobacion(
      { db: deps.db, ...(deps.alertas ? { alertas: deps.alertas } : {}), ...(deps.recordatorios ? { recordatorios: deps.recordatorios } : {}), ...(deps.logger ? { logger: deps.logger } : {}) },
      asClienteId(v.cliente_id),
      v.pieza_id,
      ahora,
    );
    if (r.resultado === 'reprogramada') salida.sinAprobacion.reprogramadas += 1;
    if (r.resultado === 'agotada') salida.sinAprobacion.agotadas += 1;
  }

  for (const v of await listProgramadasVencidas(deps.db, ahora)) {
    const sinIntentos = v.numero_intento === null && ahora.getTime() - v.fecha_hora.getTime() >= GRACIA_JOB_PERDIDO_MS;
    const reintentoPerdido = v.resultado === 'fallida' && v.resultado_en !== null && ahora.getTime() - v.resultado_en.getTime() >= GRACIA_REINTENTO_PERDIDO_MS;
    if (!sinIntentos && !reintentoPerdido) continue;
    await deps.queue.reencolar(
      { clienteId: v.cliente_id, piezaId: v.pieza_id, produccionId: v.produccion_id, fechaHora: v.fecha_hora.toISOString(), ronda: v.numero_intento ?? 0 },
      ahora,
    );
    salida.reencoladas += 1;
    log.warn({ clienteId: v.cliente_id, piezaId: v.pieza_id }, 'due piece without a send job; queued again');
  }
  return salida;
}

export interface SalidaMetricas {
  recogidas: number;
  fallidas: number;
}

/**
 * Collects the metrics snapshots that are due (24 h, 72 h, 7 d and 28 d after publishing; VERIFY). One snapshot per
 * publication and window: a repeated run cannot duplicate it. The first snapshot moves the piece to `en_medicion`
 * and the 28-day one to `cerrada`. A provider failure leaves the window pending for the next run; an auth failure
 * also raises `conexion_red_vencida`.
 */
export async function ejecutarRecoleccionMetricas(
  deps: PublicacionesJobDeps,
  ahora: Date = new Date(),
  /** Restrict the run to one piece / the next window (development scripts). The job itself passes none. */
  opciones: { clienteId?: ClienteId; piezaId?: string; limite?: number; recogidaEn?: Date } = {},
): Promise<SalidaMetricas> {
  const log = deps.logger ?? defaultLogger;
  const salida: SalidaMetricas = { recogidas: 0, fallidas: 0 };
  for (const m of await listMedicionesPendientes(deps.db, ahora, opciones)) {
    const clienteId = asClienteId(m.cliente_id);
    try {
      const conexion = await getConexionActiva(deps.db, clienteId, m.red);
      if (!conexion) throw new PublishProviderError('auth');
      const secreto = await getSecretForUse(deps.db, clienteId, conexion.id, { tipo: 'sistema' });
      const ctx: PublishContext = { red: m.red, secreto, cuenta: conexion.etiqueta };
      const metricas = deps.provider.normalizarMetricas(await deps.provider.getMetrics(m.id_externo, ctx));

      await runInTransaction(deps.db, async (tx) => {
        const pieza = await lockPlanYPieza(tx, clienteId, m.pieza_id);
        if (!pieza) return;
        const nueva = await insertMetricas(tx, clienteId, m.publicacion_id, m.ventana, metricas, opciones.recogidaEn ?? ahora);
        if (!nueva) return;
        if (pieza.estado === 'publicada') await transitionPieza(tx, clienteId, m.pieza_id, 'en_medicion', { tipo: 'sistema' }, { motivo: 'primera medicion' });
        if (m.ventana === '28d') {
          const actual = await getPieza(tx, clienteId, m.pieza_id);
          if (actual?.estado === 'en_medicion') await transitionPieza(tx, clienteId, m.pieza_id, 'cerrada', { tipo: 'sistema' }, { motivo: 'medicion completa' });
        }
      });
      salida.recogidas += 1;
    } catch (error) {
      salida.fallidas += 1;
      const kind = error instanceof PublishProviderError ? error.kind : null;
      if (kind === 'auth') await raiseAlertBestEffort(deps.alertas, 'conexion_red_vencida', { clienteId, parametros: { red: m.red, conexion_id: m.conexion_id } });
      // Ids and a closed category only: never the provider's message.
      log.warn({ clienteId, piezaId: m.pieza_id, publicacionId: m.publicacion_id, ventana: m.ventana, categoria: kind ?? 'interno' }, 'metrics collection failed; it stays pending');
      if (kind === null) throw error;
    }
  }
  return salida;
}

/** Registers the three queues and their workers. Call after boss.start(). */
export async function registerPublicacionesJobs(boss: PgBoss, deps: PublicacionesJobDeps): Promise<void> {
  await crearColasPublicacion(boss);
  await boss.schedule(BARRIDO_QUEUE, BARRIDO_CRON);
  await boss.schedule(METRICAS_QUEUE, METRICAS_CRON);
  await boss.work<unknown, SalidaPublicar>(PUBLICAR_QUEUE, { batchSize: 1 }, withFailureAlert(deps.alertas, PUBLICAR_QUEUE, async (jobs) => ejecutarJobPublicar(deps, jobs[0]!.data)));
  await boss.work(BARRIDO_QUEUE, withFailureAlert(deps.alertas, BARRIDO_QUEUE, async () => void (await ejecutarBarrido(deps))));
  await boss.work(METRICAS_QUEUE, withFailureAlert(deps.alertas, METRICAS_QUEUE, async () => void (await ejecutarRecoleccionMetricas(deps))));
}
