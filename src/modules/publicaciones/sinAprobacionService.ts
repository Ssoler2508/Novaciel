import { runInTransaction } from '../../db/transaction.js';
import type { Db } from '../../db/types.js';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { raiseAlertBestEffort, type AlertasDeps } from '../alertas/raiseAlert.js';
import { getProduccionActualBasica } from '../aprobaciones/aprobacionesRepository.js';
import type { Recordatorios } from '../aprobaciones/recordatoriosPort.js';
import { recordAudit } from '../auditoria/recordAudit.js';
import { getCurrentPerfilMarca } from '../perfilMarca/perfilMarcaRepository.js';
import { lockPlanYPieza } from '../piezas/piezasService.js';
import { parseHorariosVetados } from '../planificador/context.js';
import { getPlan } from '../planificador/planesRepository.js';
import type { ClienteId } from '../shared/clienteId.js';
import { SinHorarioPermitidoError } from './errors.js';
import { contarReprogramacionesAutomaticas } from './medicionRepository.js';
import { puedeReprogramarAutomaticamente, siguienteHorarioPermitido } from './reglasProgramacion.js';

// "No approval at the scheduled time" (spec 11.3, Step 10 design). A piece that is still waiting for an
// approval (`revision_novaciel`, `esperando_aprobacion`) when its `fecha_hora` arrives is NEVER published.
// It is moved to the next allowed slot at least 24 absolute hours ahead (VERIFY), the reminders and the
// `vencimiento` notice are queued again for the new deadline, and NovaCiel is alerted. After 3 automatic
// reschedules in a row the system stops and raises a critical alert instead.

export interface SinAprobacionDeps {
  db: Db;
  alertas?: AlertasDeps;
  recordatorios?: Recordatorios;
  logger?: Logger;
}

export type ResultadoSinAprobacion =
  | { resultado: 'reprogramada'; fechaHora: Date; reprogramaciones: number }
  | { resultado: 'agotada'; reprogramaciones: number }
  /** The piece is not waiting any more, or its time has not come: nothing to do. */
  | { resultado: 'nada' };

export async function reprogramarSinAprobacion(deps: SinAprobacionDeps, clienteId: ClienteId, piezaId: string, ahora: Date): Promise<ResultadoSinAprobacion> {
  const log = deps.logger ?? defaultLogger;
  const salida = await runInTransaction(deps.db, async (tx): Promise<ResultadoSinAprobacion & { fechaPerdida?: Date }> => {
    const pieza = await lockPlanYPieza(tx, clienteId, piezaId);
    if (!pieza) return { resultado: 'nada' };
    if (!['revision_novaciel', 'esperando_aprobacion'].includes(pieza.estado) || pieza.plan_estado !== 'aprobado') return { resultado: 'nada' };
    if (pieza.fecha_hora.getTime() > ahora.getTime()) return { resultado: 'nada' };

    const previas = await contarReprogramacionesAutomaticas(tx, clienteId, piezaId);
    if (!puedeReprogramarAutomaticamente(previas)) return { resultado: 'agotada', reprogramaciones: previas, fechaPerdida: pieza.fecha_hora };

    const plan = await getPlan(tx, clienteId, pieza.plan_id);
    if (!plan) return { resultado: 'nada' };
    const perfil = await getCurrentPerfilMarca(tx, clienteId);
    let nueva: Date;
    try {
      nueva = siguienteHorarioPermitido({ desde: ahora, zona: plan.zona_horaria, horariosVetados: parseHorariosVetados(perfil?.operacion['horarios_vetados']) });
    } catch (error) {
      if (error instanceof SinHorarioPermitidoError) return { resultado: 'agotada', reprogramaciones: previas, fechaPerdida: pieza.fecha_hora };
      throw error;
    }

    await tx.query('UPDATE piezas SET fecha_hora = $3 WHERE id = $1 AND cliente_id = $2', [piezaId, clienteId, nueva]);
    await recordAudit(tx, {
      actor: { tipo: 'sistema' },
      accion: 'reprogramar_sin_aprobacion',
      tabla: 'piezas',
      filaId: piezaId,
      clienteId,
      antes: { fecha_hora: pieza.fecha_hora.toISOString(), estado: pieza.estado },
      despues: { fecha_hora: nueva.toISOString(), reprogramaciones: previas + 1 },
    });
    // Only a piece that already waits for the client has notices to move; the others get them when the internal
    // approval leaves them waiting.
    if (deps.recordatorios && pieza.estado === 'esperando_aprobacion') {
      const actual = await getProduccionActualBasica(tx, clienteId, piezaId);
      if (actual) {
        await deps.recordatorios.programar(
          tx,
          { clienteId, tipo: 'pieza', objetoId: piezaId, plazo: nueva, zona: plan.zona_horaria, referencia: Buffer.from(actual.hashPieza).toString('hex') },
          ahora,
        );
      }
    }
    return { resultado: 'reprogramada', fechaHora: nueva, reprogramaciones: previas + 1, fechaPerdida: pieza.fecha_hora };
  });

  // Alerts after the commit.
  if (salida.resultado === 'reprogramada' && salida.fechaPerdida) {
    await raiseAlertBestEffort(deps.alertas, 'publicacion_sin_aprobacion', {
      clienteId,
      parametros: { pieza_id: piezaId, fecha_hora: salida.fechaPerdida.toISOString(), reprogramaciones: salida.reprogramaciones },
    });
    log.warn({ clienteId, piezaId, reprogramaciones: salida.reprogramaciones }, 'piece without approval at its scheduled time was rescheduled');
  } else if (salida.resultado === 'agotada' && salida.fechaPerdida) {
    await raiseAlertBestEffort(deps.alertas, 'publicacion_reprogramaciones_agotadas', {
      clienteId,
      parametros: { pieza_id: piezaId, fecha_hora: salida.fechaPerdida.toISOString() },
    });
    log.error({ clienteId, piezaId }, 'piece without approval: automatic reschedules used up');
  }
  if (salida.resultado === 'reprogramada') return { resultado: 'reprogramada', fechaHora: salida.fechaHora, reprogramaciones: salida.reprogramaciones };
  if (salida.resultado === 'agotada') return { resultado: 'agotada', reprogramaciones: salida.reprogramaciones };
  return { resultado: 'nada' };
}
