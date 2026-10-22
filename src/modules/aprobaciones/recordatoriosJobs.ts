import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import type { Notifier, Plantilla } from '../../lib/notificaciones/types.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { getPlan } from '../planificador/planesRepository.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { getHuellaPlan, getProduccionActualBasica, listRegistros } from './aprobacionesRepository.js';
import { estadoAprobacion } from './estadoAprobacion.js';
import { decidirEscalada } from './rondas.js';
import {
  planificarAvisos,
  singletonKeyAviso,
  singletonKeyEscalada,
  type PayloadRecordatorio,
  type ProgramarAvisosInput,
  type Recordatorios,
} from './recordatoriosPort.js';

// The jobs behind the reminders of spec 11.3 and the escalation of the 3rd change round.
//
// DECISIONS DO NOT CANCEL JOBS. Every job re-checks the state when it fires and does nothing if the
// approval was already decided (or the piece, the plan or the deadline changed). That is race-free and
// needs no cancel logic; the stale jobs simply finish as no-ops. Jobs are never retried automatically
// (a retry after a half-failure could notify twice), and the same notice is never queued twice
// (queue policy "exclusive" + a singleton key). Logs and outputs carry ids and codes only: never the
// caption, an idea or a comment.

export const RECORDATORIO_QUEUE = 'aprobacion-recordatorio';
export const ESCALADA_QUEUE = 'aprobacion-escalada';

const payloadSchema = z
  .object({
    clienteId: z.uuid(),
    tipo: z.enum(['pieza', 'plan']),
    objetoId: z.uuid(),
    aviso: z.enum(['recordatorio_24h', 'recordatorio_4h', 'turno_suplente']),
    referencia: z.string().regex(/^[0-9a-f]{64}$/),
    plazo: z.iso.datetime(),
  })
  .strict();
const payloadEscaladaSchema = z.object({ clienteId: z.uuid(), piezaId: z.uuid() }).strict();
export type EscaladaPayload = z.infer<typeof payloadEscaladaSchema>;

export interface RecordatoriosJobDeps {
  db: Db;
  notifier: Notifier;
  logger?: Logger;
}

export type SalidaAviso =
  | { resultado: 'enviado'; plantilla: Plantilla; destinatarios: number }
  | { resultado: 'omitido'; codigo: string }
  | { resultado: 'rechazado'; codigo: 'PayloadInvalido' };

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'UnknownError');

// ---- Who receives the notices ---------------------------------------------------------------------

/** Active users who hold a NovaCiel role (administrators and operators), in a stable order. */
async function listPersonalNovaciel(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT u.id FROM usuarios u JOIN usuario_roles ur ON ur.usuario_id = u.id
     WHERE u.activo AND ur.ambito = 'novaciel' ORDER BY u.id`,
  );
  return rows.map((r) => r.id);
}

/**
 * Re-validated when the job fires: the user is active, still holds an approval role FOR THIS CLIENT,
 * and holds no NovaCiel role (the same rule as the database guard of aprobadores_cliente).
 */
async function esAprobadorValido(db: Db, clienteId: ClienteId, usuarioId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM usuarios u
     WHERE u.id = $1 AND u.activo
       AND EXISTS (SELECT 1 FROM usuario_roles ur JOIN roles r ON r.id = ur.rol_id
                   WHERE ur.usuario_id = u.id AND ur.cliente_id = $2 AND r.codigo IN ('dueno_cliente', 'aprobador_cliente'))
       AND NOT EXISTS (SELECT 1 FROM usuario_roles ur WHERE ur.usuario_id = u.id AND ur.ambito = 'novaciel')`,
    [usuarioId, clienteId],
  );
  return rows.length > 0;
}

// ---- The reminder job -----------------------------------------------------------------------------

/** Is the approval target still waiting for the client, exactly as it was when the notice was scheduled? Null = yes, else the reason. */
async function motivoParaOmitir(db: Db, clienteId: ClienteId, p: PayloadRecordatorio, ahora: Date): Promise<string | null> {
  const plazo = new Date(p.plazo);
  if (ahora.getTime() >= plazo.getTime()) return 'plazo_vencido';
  if (p.tipo === 'pieza') {
    const pieza = await getPieza(db, clienteId, p.objetoId);
    if (!pieza) return 'objeto_no_encontrado';
    if (pieza.plan_estado !== 'aprobado' || pieza.estado !== 'esperando_aprobacion') return 'ya_decidida';
    const actual = await getProduccionActualBasica(db, clienteId, p.objetoId);
    if (!actual || Buffer.from(actual.hashPieza).toString('hex') !== p.referencia) return 'produccion_cambiada';
    if (estadoAprobacion(actual, await listRegistros(db, clienteId, p.objetoId)).estado !== 'pendiente_cliente') return 'ya_decidida';
    if (pieza.fecha_hora.getTime() !== plazo.getTime()) return 'plazo_cambiado';
    return null;
  }
  const plan = await getPlan(db, clienteId, p.objetoId);
  if (!plan) return 'objeto_no_encontrado';
  if (plan.estado !== 'propuesto') return 'ya_decidido';
  if ((await getHuellaPlan(db, clienteId, p.objetoId)) !== p.referencia) return 'plan_cambiado';
  const { rows } = await db.query<{ primero: Date | null }>('SELECT min(fecha_hora) AS primero FROM piezas WHERE plan_id = $1 AND cliente_id = $2', [p.objetoId, clienteId]);
  if (rows[0]?.primero?.getTime() !== plazo.getTime()) return 'plazo_cambiado';
  return null;
}

/** Runs one reminder job. Pure of pg-boss, so tests can call it with any `ahora`. */
export async function ejecutarJobRecordatorio(deps: RecordatoriosJobDeps, data: unknown, jobId?: string, ahora: Date = new Date()): Promise<SalidaAviso> {
  const log = deps.logger ?? defaultLogger;
  const parsed = payloadSchema.safeParse(data);
  if (!parsed.success) {
    log.warn({ jobId, resultado: 'rechazado', codigo: 'PayloadInvalido' }, 'approval reminder job rejected');
    return { resultado: 'rechazado', codigo: 'PayloadInvalido' };
  }
  const payload = parsed.data;
  const clienteId = asClienteId(payload.clienteId);
  try {
    const motivo = await motivoParaOmitir(deps.db, clienteId, payload, ahora);
    if (motivo) {
      log.info({ jobId, clienteId, tipo: payload.tipo, objetoId: payload.objetoId, aviso: payload.aviso, resultado: 'omitido', codigo: motivo }, 'approval reminder skipped');
      return { resultado: 'omitido', codigo: motivo };
    }

    const { rows } = await deps.db.query<{ principal: string; suplente: string | null }>(
      'SELECT principal_usuario_id AS principal, suplente_usuario_id AS suplente FROM aprobadores_cliente WHERE cliente_id = $1',
      [clienteId],
    );
    const fila = rows[0];
    const sucesor = payload.aviso === 'turno_suplente';
    // The substitute is optional: a client without one simply has no substitute turn.
    if (sucesor && fila && fila.suplente === null) {
      log.info({ jobId, clienteId, objetoId: payload.objetoId, aviso: payload.aviso, resultado: 'omitido', codigo: 'sin_suplente' }, 'approval reminder skipped');
      return { resultado: 'omitido', codigo: 'sin_suplente' };
    }
    const destinatario = fila ? (sucesor ? fila.suplente : fila.principal) : null;
    const referencia = { tipo: payload.tipo, id: payload.objetoId } as const;

    if (destinatario && (await esAprobadorValido(deps.db, clienteId, destinatario))) {
      await deps.notifier.enviar({ clienteId, destinatarioUsuarioId: destinatario, plantilla: payload.aviso, referencia });
      log.info({ jobId, clienteId, objetoId: payload.objetoId, aviso: payload.aviso, resultado: 'enviado' }, 'approval reminder sent');
      return { resultado: 'enviado', plantilla: payload.aviso, destinatarios: 1 };
    }

    // No approver set, or the one set is no longer valid (inactive, role revoked): NovaCiel is told instead.
    const personal = await listPersonalNovaciel(deps.db);
    for (const usuarioId of personal) {
      await deps.notifier.enviar({ clienteId, destinatarioUsuarioId: usuarioId, plantilla: 'aprobador_no_configurado', referencia });
    }
    log.warn({ jobId, clienteId, objetoId: payload.objetoId, aviso: payload.aviso, resultado: 'aviso_a_novaciel', destinatarios: personal.length }, 'approver not valid; NovaCiel told');
    return { resultado: 'enviado', plantilla: 'aprobador_no_configurado', destinatarios: personal.length };
  } catch (error) {
    log.error({ jobId, clienteId, objetoId: payload.objetoId, aviso: payload.aviso, errorName: errorName(error) }, 'approval reminder job failed');
    throw error;
  }
}

/** Runs one escalation job: tells every NovaCiel administrator and operator that a piece passed the allowed rounds. */
export async function ejecutarJobEscalada(deps: RecordatoriosJobDeps, data: unknown, jobId?: string): Promise<SalidaAviso> {
  const log = deps.logger ?? defaultLogger;
  const parsed = payloadEscaladaSchema.safeParse(data);
  if (!parsed.success) {
    log.warn({ jobId, resultado: 'rechazado', codigo: 'PayloadInvalido' }, 'escalation job rejected');
    return { resultado: 'rechazado', codigo: 'PayloadInvalido' };
  }
  const { clienteId: raw, piezaId } = parsed.data;
  const clienteId = asClienteId(raw);
  try {
    const pieza = await getPieza(deps.db, clienteId, piezaId);
    if (!pieza) return { resultado: 'omitido', codigo: 'objeto_no_encontrado' };
    if (!decidirEscalada(await listRegistros(deps.db, clienteId, piezaId)).escalada) return { resultado: 'omitido', codigo: 'no_escalada' };
    const personal = await listPersonalNovaciel(deps.db);
    for (const usuarioId of personal) {
      await deps.notifier.enviar({ clienteId, destinatarioUsuarioId: usuarioId, plantilla: 'escalada_cambios', referencia: { tipo: 'pieza', id: piezaId } });
    }
    log.info({ jobId, clienteId, piezaId, resultado: 'enviado', destinatarios: personal.length }, 'escalation sent');
    return { resultado: 'enviado', plantilla: 'escalada_cambios', destinatarios: personal.length };
  } catch (error) {
    log.error({ jobId, clienteId, piezaId, errorName: errorName(error) }, 'escalation job failed');
    throw error;
  }
}

// ---- pg-boss --------------------------------------------------------------------------------------

/**
 * Creates both queues (exclusive, no automatic retries). Idempotent. The server, the development scripts
 * and the workers all call it, so a notice can be queued by whoever needs to, before any worker exists.
 * Call after boss.start().
 */
export async function crearColasRecordatorios(boss: PgBoss): Promise<void> {
  await boss.createQueue(RECORDATORIO_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
  await boss.createQueue(ESCALADA_QUEUE, { policy: 'exclusive', retryLimit: 0, expireInSeconds: 900 });
}

/** Registers both queues and their workers. Call after boss.start(). */
export async function registerRecordatoriosJobs(boss: PgBoss, deps: RecordatoriosJobDeps): Promise<void> {
  await crearColasRecordatorios(boss);
  await boss.work<unknown, SalidaAviso>(RECORDATORIO_QUEUE, { batchSize: 1 }, async (jobs) => ejecutarJobRecordatorio(deps, jobs[0]!.data, jobs[0]!.id));
  await boss.work<unknown, SalidaAviso>(ESCALADA_QUEUE, { batchSize: 1 }, async (jobs) => ejecutarJobEscalada(deps, jobs[0]!.data, jobs[0]!.id));
}

export interface AvisoEncolado {
  jobId: string;
  estado: string;
  aviso: string;
  cuando: Date;
}

/**
 * The reminder jobs queued for an approval target (a piece or a plan), oldest first. Read-only; for the
 * development scripts and the final check. `schema` is the pg-boss schema (default "pgboss").
 */
export async function listarAvisosEncolados(db: Db, objetoId: string, schema = 'pgboss'): Promise<AvisoEncolado[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid pg-boss schema name');
  const { rows } = await db.query<{ id: string; state: string; aviso: string; start_after: Date }>(
    `SELECT id, state, data->>'aviso' AS aviso, start_after FROM ${schema}.job WHERE name = $1 AND data->>'objetoId' = $2 ORDER BY start_after, id`,
    [RECORDATORIO_QUEUE, objetoId],
  );
  return rows.map((r) => ({ jobId: r.id, estado: r.state, aviso: r.aviso, cuando: r.start_after }));
}

/**
 * The real port. It sends the jobs THROUGH THE CALLER'S TRANSACTION (pg-boss's `db` option), so a
 * notice exists if and only if the decision that needs it committed.
 */
export function createPgBossRecordatorios(boss: PgBoss): Recordatorios {
  const enTransaccion = (tx: Db) => ({ executeSql: async (text: string, values?: unknown[]) => ({ rows: (await tx.query(text, values as never[])).rows }) });
  return {
    async programar(tx, input: ProgramarAvisosInput, ahora = new Date()) {
      const avisos = planificarAvisos(input, ahora);
      for (const a of avisos) {
        await boss.send(RECORDATORIO_QUEUE, a.payload, { startAfter: a.cuando, singletonKey: singletonKeyAviso(a.payload), db: enTransaccion(tx) });
      }
      return avisos.map((a) => a.aviso);
    },
    async escalar(tx, input) {
      await boss.send(ESCALADA_QUEUE, input satisfies EscaladaPayload, { singletonKey: singletonKeyEscalada(input.clienteId, input.piezaId), db: enTransaccion(tx) });
    },
  };
}
