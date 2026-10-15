import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';
import { canTransition, type EstadoPieza } from './estados.js';
import { InvalidPiezaInputError, InvalidTransitionError, NotPausedError, PiezaNotFoundError, PlanDescartadoError } from './errors.js';
import { getPieza, PIEZA_COLUMNS, PIEZA_FROM, type PiezaRow } from './piezasRepository.js';

// The only code that changes a piece's state. The database enforces the same rules with a trigger
// (transiciones_pieza + a history row per change in the same transaction); this layer rejects an
// invalid transition first, so it never reaches the database. Who may ask for which transition is
// decided later (routes and approvals): the service accepts any actor.

export interface TransitionOptions {
  /** Why the state changes. Optional, 1 to 500 characters once trimmed. */
  motivo?: string;
}

const MAX_MOTIVO_LENGTH = 500;

function cleanMotivo(motivo: string | undefined): string | null {
  if (motivo === undefined) return null;
  const trimmed = motivo.trim();
  if (trimmed === '' || trimmed.length > MAX_MOTIVO_LENGTH) {
    throw new InvalidPiezaInputError(`motivo must have 1 to ${MAX_MOTIVO_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * Locks the piece row of this client for the rest of the transaction (and its plan row in share
 * mode, so the plan cannot be discarded under it), or null. A piece of a discarded plan is refused
 * here, under the same lock; the database trigger refuses it too.
 */
async function lockPieza(tx: Db, clienteId: ClienteId, piezaId: string): Promise<PiezaRow | null> {
  const { rows } = await tx.query<PiezaRow>(
    `SELECT ${PIEZA_COLUMNS} ${PIEZA_FROM} WHERE p.id = $1 AND p.cliente_id = $2 FOR UPDATE OF p FOR SHARE OF pl`,
    [piezaId, clienteId],
  );
  const pieza = rows[0] ?? null;
  if (pieza?.plan_estado === 'descartado') throw new PlanDescartadoError();
  return pieza;
}

/** The transition itself, on a piece that is already locked. */
async function applyTransition(
  tx: Db,
  pieza: PiezaRow,
  hacia: EstadoPieza,
  actor: AuditActor,
  motivo: string | null,
): Promise<PiezaRow> {
  // Rejected here, before any write, so the database never sees an invalid transition from the service.
  if (!canTransition(pieza.estado, hacia, pieza.estado_previo)) throw new InvalidTransitionError(pieza.estado, hacia);

  // The history row goes first (the trigger requires it), then the state. estado_previo and
  // version_estado are set by the trigger, never by this code.
  await tx.query(
    `INSERT INTO historial_estados_pieza (cliente_id, pieza_id, version, desde, hacia, actor_tipo, actor_usuario_id, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      pieza.cliente_id,
      pieza.id,
      pieza.version_estado + 1,
      pieza.estado,
      hacia,
      actor.tipo,
      actor.tipo === 'usuario' ? actor.usuarioId : null,
      motivo,
    ],
  );
  await tx.query('UPDATE piezas SET estado = $3 WHERE id = $1 AND cliente_id = $2', [pieza.id, pieza.cliente_id, hacia]);
  const after = (await getPieza(tx, pieza.cliente_id, pieza.id))!;

  await recordAudit(tx, {
    actor,
    accion: 'cambiar_estado',
    tabla: 'piezas',
    filaId: pieza.id,
    clienteId: pieza.cliente_id,
    antes: { estado: pieza.estado, estado_previo: pieza.estado_previo },
    despues: { estado: after.estado, estado_previo: after.estado_previo, version_estado: after.version_estado, ...(motivo ? { motivo } : {}) },
  });
  return after;
}

/**
 * Moves a piece to `hacia`. One transaction: lock the piece (filtered by client), check the
 * transition, write the history row, update the state, write the audit row.
 * Throws PiezaNotFoundError for a piece of another client, InvalidTransitionError otherwise.
 */
export async function transitionPieza(
  db: Db,
  clienteId: ClienteId,
  piezaId: string,
  hacia: EstadoPieza,
  actor: AuditActor,
  options: TransitionOptions = {},
): Promise<PiezaRow> {
  const motivo = cleanMotivo(options.motivo);
  return runInTransaction(db, async (tx) => {
    const pieza = await lockPieza(tx, clienteId, piezaId);
    if (!pieza) throw new PiezaNotFoundError();
    return applyTransition(tx, pieza, hacia, actor, motivo);
  });
}

/** Pauses a piece (any non-terminal state). Terminal and already paused pieces are invalid transitions. */
export function pausarPieza(db: Db, clienteId: ClienteId, piezaId: string, actor: AuditActor, options: TransitionOptions = {}): Promise<PiezaRow> {
  return transitionPieza(db, clienteId, piezaId, 'pausada', actor, options);
}

/** Resumes a paused piece, back to the state it was paused from. NotPausedError when it is not paused. */
export async function reanudarPieza(
  db: Db,
  clienteId: ClienteId,
  piezaId: string,
  actor: AuditActor,
  options: TransitionOptions = {},
): Promise<PiezaRow> {
  const motivo = cleanMotivo(options.motivo);
  return runInTransaction(db, async (tx) => {
    // Read and use estado_previo under the same lock: nothing can change it in between.
    const pieza = await lockPieza(tx, clienteId, piezaId);
    if (!pieza) throw new PiezaNotFoundError();
    if (pieza.estado !== 'pausada' || pieza.estado_previo === null) throw new NotPausedError(pieza.estado);
    return applyTransition(tx, pieza, pieza.estado_previo, actor, motivo);
  });
}
