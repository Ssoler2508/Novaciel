import { z } from 'zod';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit } from '../auditoria/recordAudit.js';
import { PiezaNotFoundError } from '../piezas/errors.js';
import type { EstadoPieza } from '../piezas/estados.js';
import { getPieza, PIEZA_COLUMNS, PIEZA_FROM, type PiezaRow } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { PlanNoAprobadoError } from '../planificador/errors.js';
import type { ClienteId } from '../shared/clienteId.js';
import { esPersonalNovaciel, requireAction, rolParaNivel, type AprobadorActor } from './actor.js';
import { getProduccionActualBasica, listRegistros } from './aprobacionesRepository.js';
import {
  AprobacionInvalidaError,
  HashDesactualizadoError,
  PermisoDenegadoError,
  PiezaEstadoNoDecidibleError,
  SinProduccionError,
} from './errors.js';
import { estadoAprobacion, type EstadoAprobacion } from './estadoAprobacion.js';
import type { Recordatorios } from './recordatoriosPort.js';
import { decidirEscalada, type DecisionEscalada } from './rondas.js';

// Records a decision about the EXACT current production of a piece and moves the piece (ADR-05).
// LOCK ORDER (the same everywhere): the plan first, then the piece.

const MOTIVOS = ['texto', 'musica', 'toma', 'gancho', 'dato_equivocado', 'otro'] as const;

const decisionSchema = z.object({
  nivel: z.enum(['interno', 'cliente']),
  decision: z.enum(['aprobada', 'cambios', 'rechazada']),
  /** The hash_pieza the approver was shown, lower-case hex. */
  hashVisto: z.string().regex(/^[0-9a-f]{64}$/),
  /** Required for a change request or a rejection; none for an approval. */
  motivo: z.enum(MOTIVOS).optional(),
  segundoMs: z.number().int().min(0).optional(),
  /** CLIENT DATA: stored, never logged or audited. */
  comentario: z.string().trim().min(1).max(2000).optional(),
  /** A coarse label such as "movil · Safari"; never a full user agent or an IP. */
  dispositivo: z.string().trim().min(1).max(40).optional(),
});
export type DecisionInput = z.input<typeof decisionSchema>;

export interface AprobacionRegistrada {
  id: string;
  seq: string;
  nivel: 'interno' | 'cliente';
  decision: 'aprobada' | 'cambios' | 'rechazada';
  produccionId: string;
  version: number;
}

export interface DecisionRegistrada {
  aprobacion: AprobacionRegistrada;
  pieza: PiezaRow;
  estadoAprobacion: EstadoAprobacion;
  /** For the notifier of checkpoint D: `notificarAhora` is true only on the 3rd client change request. */
  escalada: DecisionEscalada;
}

/** `recordatorios` is optional: without it nothing is scheduled (callers with no queue, most tests). */
export interface AprobacionesDeps {
  db: Db;
  recordatorios?: Recordatorios;
}

/** Locks the plan, then the piece (FOR UPDATE), of this client. Null when the piece is not the client's. */
async function lockPlanYPieza(tx: Db, clienteId: ClienteId, piezaId: string): Promise<PiezaRow | null> {
  const { rows: ids } = await tx.query<{ plan_id: string }>('SELECT plan_id FROM piezas WHERE id = $1 AND cliente_id = $2', [piezaId, clienteId]);
  const planId = ids[0]?.plan_id;
  if (!planId) return null;
  await tx.query('SELECT id FROM planes_semanales WHERE id = $1 AND cliente_id = $2 FOR SHARE', [planId, clienteId]);
  const { rows } = await tx.query<PiezaRow>(
    `SELECT ${PIEZA_COLUMNS} ${PIEZA_FROM} WHERE p.id = $1 AND p.cliente_id = $2 FOR UPDATE OF p`,
    [piezaId, clienteId],
  );
  return rows[0] ?? null;
}

/**
 * Records a decision and moves the piece, atomically.
 *
 *   interno + aprobada   revision_novaciel -> esperando_aprobacion (the piece got there by passing QC)
 *   interno + cambios    revision_novaciel -> con_cambios (NovaCiel only; not a client change round)
 *   cliente + aprobada   esperando_aprobacion -> aprobada
 *   cliente + cambios    esperando_aprobacion -> con_cambios
 *   cliente + rechazada  esperando_aprobacion -> rechazada
 *
 * The audit row carries ids, level, decision and the hash; never the comment.
 *
 * Inside the same transaction (so they exist if and only if the decision committed):
 *   - an internal approval, which leaves the piece waiting for the client, schedules the reminders of
 *     spec 11.3 (24 h, 4 h, the substitute's turn);
 *   - the 3rd client change request queues the escalation notice for NovaCiel.
 */
export async function registrarDecision(
  deps: AprobacionesDeps,
  clienteId: ClienteId,
  piezaId: string,
  actor: AprobadorActor,
  input: DecisionInput,
): Promise<DecisionRegistrada> {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) throw new AprobacionInvalidaError([...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? 'input')))]);
  const d = parsed.data;
  const rol = rolParaNivel(actor, d.nivel, clienteId);
  if ((d.decision === 'aprobada') === (d.motivo !== undefined)) throw new AprobacionInvalidaError(['motivo']);
  if (d.decision === 'rechazada' && d.nivel === 'interno') throw new AprobacionInvalidaError(['decision']);
  if (d.segundoMs !== undefined && d.decision !== 'cambios') throw new AprobacionInvalidaError(['segundoMs']);

  return runInTransaction(deps.db, async (tx) => {
    const pieza = await lockPlanYPieza(tx, clienteId, piezaId);
    if (!pieza) throw new PiezaNotFoundError();
    if (pieza.plan_estado !== 'aprobado') throw new PlanNoAprobadoError(pieza.plan_estado);
    const estadosValidos: EstadoPieza[] = d.nivel === 'interno' ? ['revision_novaciel'] : ['esperando_aprobacion'];
    if (!estadosValidos.includes(pieza.estado)) throw new PiezaEstadoNoDecidibleError(d.nivel, pieza.estado);

    const actual = await getProduccionActualBasica(tx, clienteId, piezaId);
    if (!actual) throw new SinProduccionError();
    const hashActual = Buffer.from(actual.hashPieza).toString('hex');
    if (d.hashVisto !== hashActual) throw new HashDesactualizadoError(actual.id);

    const { rows } = await tx.query<AprobacionRegistrada & { produccion_id: string }>(
      `INSERT INTO aprobaciones
         (cliente_id, pieza_id, produccion_id, version, hash_version, hash_pieza, nivel, decision, usuario_id, rol_id,
          motivo, segundo_ms, comentario, dispositivo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT id FROM roles WHERE codigo = $10), $11, $12, $13, $14)
       RETURNING id, seq::text AS seq, nivel, decision, produccion_id AS "produccionId", version`,
      [
        clienteId, piezaId, actual.id, actual.version, actual.hashVersion, actual.hashPieza, d.nivel, d.decision,
        actor.usuarioId, rol, d.motivo ?? null, d.segundoMs ?? null, d.comentario ?? null, d.dispositivo ?? null,
      ],
    );
    const aprobacion = rows[0]!;

    const quien = { tipo: 'usuario', usuarioId: actor.usuarioId } as const;
    if (d.nivel === 'interno' && d.decision === 'aprobada') {
      await transitionPieza(tx, clienteId, piezaId, 'esperando_aprobacion', quien, { motivo: 'aprobacion_interna' });
    } else if (d.nivel === 'interno') {
      await transitionPieza(tx, clienteId, piezaId, 'con_cambios', quien, { motivo: 'cambios_internos' });
    } else {
      const hacia = { aprobada: 'aprobada', cambios: 'con_cambios', rechazada: 'rechazada' }[d.decision] as EstadoPieza;
      await transitionPieza(tx, clienteId, piezaId, hacia, quien, { motivo: `decision_cliente_${d.decision}` });
    }

    await recordAudit(tx, {
      actor: quien,
      accion: 'decidir',
      tabla: 'aprobaciones',
      filaId: aprobacion.id,
      clienteId,
      despues: {
        pieza_id: piezaId,
        produccion_id: actual.id,
        version: actual.version,
        hash_version: actual.hashVersion,
        hash_pieza: hashActual,
        nivel: d.nivel,
        decision: d.decision,
        rol,
      },
    });

    const registros = await listRegistros(tx, clienteId, piezaId);
    const despues = (await getPieza(tx, clienteId, piezaId))!;
    // `notificarAhora` is true for the count, so it is also true on the next decision of the same piece
    // (for example the next internal approval): only the client change request that made the count reach
    // the limit tells NovaCiel.
    const cuenta = decidirEscalada(registros);
    const escalada = { ...cuenta, notificarAhora: cuenta.notificarAhora && d.nivel === 'cliente' && d.decision === 'cambios' };

    if (deps.recordatorios) {
      if (despues.estado === 'esperando_aprobacion') {
        const { rows: zonas } = await tx.query<{ zona_horaria: string }>('SELECT zona_horaria FROM planes_semanales WHERE id = $1 AND cliente_id = $2', [despues.plan_id, clienteId]);
        await deps.recordatorios.programar(tx, {
          clienteId,
          tipo: 'pieza',
          objetoId: piezaId,
          plazo: despues.fecha_hora,
          zona: zonas[0]!.zona_horaria,
          referencia: hashActual,
        });
      }
      if (escalada.notificarAhora) await deps.recordatorios.escalar(tx, { clienteId, piezaId });
    }

    return { aprobacion, pieza: despues, estadoAprobacion: estadoAprobacion(actual, registros), escalada };
  });
}

/**
 * NovaCiel pulls a reviewed, approved or scheduled piece back to `con_cambios` (spec 11.3: any change after the
 * approval voids it). Only NovaCiel (manage_plans); the database refuses a client user too. The piece
 * then goes through production again, and the new production version voids every earlier approval.
 */
export async function reabrirPieza(
  deps: AprobacionesDeps,
  clienteId: ClienteId,
  piezaId: string,
  actor: AprobadorActor,
  motivo: string,
): Promise<PiezaRow> {
  requireAction(actor, 'manage_plans', clienteId);
  if (!esPersonalNovaciel(actor)) throw new PermisoDenegadoError('manage_plans');
  return runInTransaction(deps.db, async (tx) => {
    const pieza = await lockPlanYPieza(tx, clienteId, piezaId);
    if (!pieza) throw new PiezaNotFoundError();
    return transitionPieza(tx, clienteId, piezaId, 'con_cambios', { tipo: 'usuario', usuarioId: actor.usuarioId }, { motivo });
  });
}
