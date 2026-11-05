import { runInTransaction } from '../../db/transaction.js';
import type { Db } from '../../db/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import type { Recordatorios } from '../aprobaciones/recordatoriosPort.js';
import { assertPublicable } from '../aprobaciones/publicable.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { PiezaNotFoundError } from '../piezas/errors.js';
import { getPieza, type PiezaRow } from '../piezas/piezasRepository.js';
import { lockPlanYPieza, transitionPieza } from '../piezas/piezasService.js';
import { getCurrentPerfilMarca } from '../perfilMarca/perfilMarcaRepository.js';
import { parseHorariosVetados } from '../planificador/context.js';
import { getPlan } from '../planificador/planesRepository.js';
import type { ClienteId } from '../shared/clienteId.js';
import { PiezaEstadoProgramacionError, ProgramacionInvalidaError, PublicacionAbiertaError } from './errors.js';
import type { PublicacionQueue } from './publicacionQueue.js';
import { getUltimoIntento } from './publicacionesRepository.js';
import { validarProgramacion } from './reglasProgramacion.js';

// Scheduling (Step 10, checkpoint C). The rules are the pure ones of checkpoint B (future time, outside the
// vetoed hours of the plan's zone) plus the central gate: the piece must be publishable NOW, so a piece that
// is already broken never reaches `programada`. One transaction: plan lock, then piece lock.
//
// `fecha_hora` is not part of np1, so changing it keeps the approvals; the reminders and the `vencimiento`
// notice are queued again for the new deadline (the old ones carry the old deadline and do nothing).
// Who may call these (permission `schedule_pieces`) is decided by the routes of checkpoint D.

export interface ProgramacionDeps {
  db: Db;
  storage: Storage;
  recordatorios?: Recordatorios;
  /** Queues the scheduled send inside the transaction. Absent: none is queued (tests, scripts). */
  publicaciones?: PublicacionQueue;
  /** The clock. Default: the real one. */
  now?: () => Date;
}

type Operacion = 'programar' | 'reprogramar';

const ESTADOS_DE_ORIGEN: Record<Operacion, readonly string[]> = {
  // `fallo_publicacion` is the manual retry: it goes through the very same rules as a first schedule.
  programar: ['aprobada', 'fallo_publicacion'],
  reprogramar: ['programada'],
};

async function programarInterno(
  deps: ProgramacionDeps,
  clienteId: ClienteId,
  piezaId: string,
  fechaHora: Date,
  actor: AuditActor,
  operacion: Operacion,
): Promise<PiezaRow> {
  const ahora = (deps.now ?? (() => new Date()))();
  return runInTransaction(deps.db, async (tx) => {
    const pieza = await lockPlanYPieza(tx, clienteId, piezaId);
    if (!pieza) throw new PiezaNotFoundError();
    if (!ESTADOS_DE_ORIGEN[operacion].includes(pieza.estado)) throw new PiezaEstadoProgramacionError(pieza.estado, operacion);

    if (operacion === 'reprogramar') {
      // An attempt that is still open (no result) is being sent right now: the time cannot move under it.
      const actual = await tx.query<{ id: string }>('SELECT id FROM producciones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual', [piezaId, clienteId]);
      const intento = actual.rows[0] ? await getUltimoIntento(tx, clienteId, actual.rows[0].id) : null;
      if (intento && intento.resultado === null) throw new PublicacionAbiertaError();
    }

    // The gate, with the piece locked: approvals of the exact files, QC, facts and media, files re-hashed.
    const publicable = await assertPublicable({ db: tx, storage: deps.storage }, clienteId, piezaId, { estados: [pieza.estado] });

    const plan = await getPlan(tx, clienteId, pieza.plan_id);
    if (!plan) throw new PiezaNotFoundError();
    const perfil = await getCurrentPerfilMarca(tx, clienteId);
    const horariosVetados = parseHorariosVetados(perfil?.operacion['horarios_vetados']);
    const validacion = validarProgramacion({ fechaHora, ahora, zona: plan.zona_horaria, horariosVetados });
    if (!validacion.ok) throw new ProgramacionInvalidaError(validacion.motivos);

    await tx.query('UPDATE piezas SET fecha_hora = $3 WHERE id = $1 AND cliente_id = $2', [piezaId, clienteId, fechaHora]);
    if (pieza.estado !== 'programada') {
      await transitionPieza(tx, clienteId, piezaId, 'programada', actor, { motivo: pieza.estado === 'fallo_publicacion' ? 'reintento manual' : 'programada' });
    }
    await recordAudit(tx, {
      actor,
      accion: operacion === 'programar' ? 'programar_pieza' : 'reprogramar_pieza',
      tabla: 'piezas',
      filaId: piezaId,
      clienteId,
      antes: { fecha_hora: pieza.fecha_hora.toISOString(), estado: pieza.estado },
      despues: { fecha_hora: fechaHora.toISOString(), produccion_id: publicable.produccionId, hash_pieza: publicable.hashPieza },
    });

    if (deps.recordatorios) {
      await deps.recordatorios.programar(
        tx,
        { clienteId, tipo: 'pieza', objetoId: piezaId, plazo: fechaHora, zona: plan.zona_horaria, referencia: publicable.hashPieza },
        ahora,
      );
    }
    // The scheduled send, in the same transaction: it exists if and only if the schedule committed.
    if (deps.publicaciones) {
      await deps.publicaciones.programar(
        tx,
        { clienteId, piezaId, produccionId: publicable.produccionId, fechaHora: fechaHora.toISOString(), ronda: 0 },
        fechaHora,
      );
    }
    return (await getPieza(tx, clienteId, piezaId))!;
  });
}

/**
 * Cancels a schedule: `programada -> con_cambios` (the existing transition; NovaCiel only, the caller checks
 * `schedule_pieces`). Refused while an attempt is open. The queued send finds the piece no longer `programada`
 * and does nothing.
 */
export async function cancelarProgramacion(deps: Pick<ProgramacionDeps, 'db'>, clienteId: ClienteId, piezaId: string, actor: AuditActor, motivo: string): Promise<PiezaRow> {
  return runInTransaction(deps.db, async (tx) => {
    const pieza = await lockPlanYPieza(tx, clienteId, piezaId);
    if (!pieza) throw new PiezaNotFoundError();
    if (pieza.estado !== 'programada') throw new PiezaEstadoProgramacionError(pieza.estado, 'reprogramar');
    const actual = await tx.query<{ id: string }>('SELECT id FROM producciones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual', [piezaId, clienteId]);
    const intento = actual.rows[0] ? await getUltimoIntento(tx, clienteId, actual.rows[0].id) : null;
    if (intento && intento.resultado === null) throw new PublicacionAbiertaError();
    const despues = await transitionPieza(tx, clienteId, piezaId, 'con_cambios', actor, { motivo });
    await recordAudit(tx, {
      actor,
      accion: 'cancelar_programacion',
      tabla: 'piezas',
      filaId: piezaId,
      clienteId,
      antes: { fecha_hora: pieza.fecha_hora.toISOString(), estado: pieza.estado },
      despues: { estado: despues.estado },
    });
    return despues;
  });
}

/**
 * `aprobada -> programada` at `fechaHora`, or the manual retry `fallo_publicacion -> programada`. Refuses a
 * piece that is not publishable, a time in the past and a vetoed hour.
 */
export function programarPieza(deps: ProgramacionDeps, clienteId: ClienteId, piezaId: string, fechaHora: Date, actor: AuditActor): Promise<PiezaRow> {
  return programarInterno(deps, clienteId, piezaId, fechaHora, actor, 'programar');
}

/** Moves the time of a `programada` piece. Same rules; the approvals stay; reminders and notice are queued again. */
export function reprogramarPieza(deps: ProgramacionDeps, clienteId: ClienteId, piezaId: string, fechaHora: Date, actor: AuditActor): Promise<PiezaRow> {
  return programarInterno(deps, clienteId, piezaId, fechaHora, actor, 'reprogramar');
}
