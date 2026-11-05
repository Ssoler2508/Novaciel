import type { Db } from '../db/types.js';
import type { Storage } from '../lib/media/storage/types.js';
import type { PublishProvider } from '../lib/publish/types.js';
import type { AlertasDeps } from '../modules/alertas/raiseAlert.js';
import * as aprobaciones from '../modules/aprobaciones/index.js';
import type { Recordatorios } from '../modules/aprobaciones/index.js';
import { InvalidTransitionError, PiezaNotFoundError } from '../modules/piezas/errors.js';
import { getPieza } from '../modules/piezas/piezasRepository.js';
import { ProduccionHechoVencidoError, ProduccionMediaNoUsableError } from '../modules/produccion/errors.js';
import { getUsuarioByEmail } from '../modules/usuarios/usuariosRepository.js';
import * as pub from '../modules/publicaciones/errors.js';
import { getPublicacionPublicada, listSnapshotsDePieza } from '../modules/publicaciones/medicionRepository.js';
import { VENTANAS, ventanasDeMedicion } from '../modules/publicaciones/normalizarMetricas.js';
import { ejecutarRecoleccionMetricas } from '../modules/publicaciones/publicacionesJobs.js';
import { FakePublicacionQueue, type PublicacionQueue } from '../modules/publicaciones/publicacionQueue.js';
import { publicarPieza } from '../modules/publicaciones/publicacionService.js';
import { programarPieza, reprogramarPieza } from '../modules/publicaciones/programacionService.js';
import type { PieceScheduleArgs, PiezaArgs } from './publicacionesArgs.js';
import type { ScriptResult } from './aprobacionesCore.js';
import { SEED_ADMIN_EMAIL } from './seedDevelopment.js';

// The cores of the Step 10 development scripts. They print ids, states, hashes and error names only:
// NEVER the copy of a piece or a credential. They never reach a network: the provider is the one the
// configuration chose (the fake, until checkpoint F).

export interface PublicacionScriptDeps {
  db: Db;
  storage: Storage;
  provider: PublishProvider;
  recordatorios?: Recordatorios;
  /** The pg-boss port that queues the scheduled send. Absent: none is queued (the server's sweep picks the piece up). */
  publicaciones?: PublicacionQueue;
  /** Alerts (so a failure in a script raises what the server would). Absent: none. */
  alertas?: AlertasDeps;
  now?: () => Date;
}

const NO_ADMIN = `The seeded NovaCiel administrator (${SEED_ADMIN_EMAIL}) does not exist or is inactive: run npm run seed`;

function failure(error: unknown): string {
  if (error instanceof PiezaNotFoundError) return 'That piece does not exist for this client';
  if (error instanceof InvalidTransitionError) return 'The piece cannot move that way from its current state';
  if (error instanceof pub.PiezaEstadoProgramacionError) return `The piece is in state ${error.estado}; it cannot be ${error.operacion === 'publicar' ? 'published' : 'scheduled'} from there`;
  if (error instanceof pub.ProgramacionInvalidaError) return `That time is not allowed: ${error.motivos.join(', ')}`;
  if (error instanceof pub.PublicacionAbiertaError) return 'An attempt is still open for this piece; wait for its result';
  if (error instanceof pub.PublicacionPrematuraError) return 'The scheduled time has not come yet';
  if (error instanceof pub.ConexionNoDisponibleError) return `REFUSED: no usable connection for the network (${error.motivo}); the piece is in fallo_publicacion`;
  if (error instanceof pub.EtiquetaIaNoSoportadaError) return 'REFUSED: the provider cannot set the AI-content label; the piece is in fallo_publicacion';
  if (error instanceof pub.ArchivoAlteradoAlEnviarError) return `REFUSED: file ${error.orden} changed just before sending; nothing was sent; the piece is in fallo_publicacion`;
  if (error instanceof pub.PublicacionAgotadaError) return 'REFUSED: the attempts are used up; the piece is in fallo_publicacion';
  if (error instanceof aprobaciones.PiezaNoPublicableError) return `REFUSED: ${error.name} (state ${error.estado}, plan ${error.planEstado})`;
  if (error instanceof aprobaciones.SinAprobacionVigenteError) return `REFUSED: ${error.name} (${error.estadoAprobacion})`;
  if (error instanceof aprobaciones.ControlCalidadNoAprobadoError) return `REFUSED: ${error.name} (${error.estadoQc})`;
  if (error instanceof aprobaciones.ArchivoAlteradoError) return `REFUSED: ${error.name} (file ${error.orden}, ${error.motivo}); the piece is in fallo_publicacion`;
  if (error instanceof aprobaciones.HashPiezaNoCoincideError) return `REFUSED: ${error.name} (against the ${error.contra} hash)`;
  if (error instanceof ProduccionHechoVencidoError) return `REFUSED: ${error.name} (${error.hechoIds.length} fact(s))`;
  if (error instanceof ProduccionMediaNoUsableError) return `REFUSED: ${error.name} (${error.mediaIds.length} media)`;
  return `Failed (${error instanceof Error ? error.name : 'unknown error'})`;
}

/** Schedules an approved piece (or retries one in fallo_publicacion), or reschedules a programada one. */
export async function runPieceSchedule(deps: PublicacionScriptDeps, args: PieceScheduleArgs): Promise<ScriptResult> {
  try {
    const admin = await getUsuarioByEmail(deps.db, SEED_ADMIN_EMAIL);
    if (!admin || !admin.activo) return { ok: false, lines: [NO_ADMIN] };
    const actor = { tipo: 'usuario', usuarioId: admin.id } as const;
    const antes = await getPieza(deps.db, args.clienteId, args.piezaId);
    if (!antes) throw new PiezaNotFoundError();
    const servicio = antes.estado === 'programada' ? reprogramarPieza : programarPieza;
    const pieza = await servicio(
      {
        db: deps.db,
        storage: deps.storage,
        ...(deps.recordatorios ? { recordatorios: deps.recordatorios } : {}),
        ...(deps.publicaciones ? { publicaciones: deps.publicaciones } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      },
      args.clienteId,
      args.piezaId,
      args.at,
      actor,
    );
    return {
      ok: true,
      lines: [
        `Piece ${pieza.id} is ${pieza.estado} for ${pieza.fecha_hora.toISOString()}`,
        deps.publicaciones ? 'The send is queued for that time' : 'No queue here: the server sweep will queue the send once the time has come',
      ],
    };
  } catch (error) {
    return { ok: false, lines: [failure(error)] };
  }
}

/**
 * Publishes a programada piece NOW through the same gate (assertPublicable, locks, attempt record, key). Only the
 * wait for `fecha_hora` is skipped: the clock handed to the service is never earlier than the piece's time.
 */
export async function runPiecePublish(deps: PublicacionScriptDeps, args: PiezaArgs): Promise<ScriptResult> {
  try {
    const pieza = await getPieza(deps.db, args.clienteId, args.piezaId);
    if (!pieza) throw new PiezaNotFoundError();
    if (pieza.estado !== 'programada') throw new pub.PiezaEstadoProgramacionError(pieza.estado, 'publicar');
    const relojReal = (deps.now ?? (() => new Date()))();
    const ahora = new Date(Math.max(relojReal.getTime(), pieza.fecha_hora.getTime()));
    const r = await publicarPieza(
      { db: deps.db, storage: deps.storage, provider: deps.provider, ...(deps.alertas ? { alertas: deps.alertas } : {}), now: () => ahora },
      args.clienteId,
      args.piezaId,
      { tipo: 'sistema' },
    );
    switch (r.estado) {
      case 'publicada':
        return {
          ok: true,
          lines: [
            `Piece ${args.piezaId} PUBLISHED (attempt ${r.intento}${r.yaEstabaPublicada ? ', the provider already had it: nothing was sent again' : ''}); external id ${r.idExterno}`,
            ...(r.enlace ? [`  link ${r.enlace}`] : []),
          ],
        };
      case 'en_curso':
        return { ok: true, lines: ['Another call is sending this piece right now (en_curso); nothing was sent'] };
      case 'reintento':
        return { ok: true, lines: [`Attempt ${r.intento} failed (${r.categoria}); a retry is due in ${Math.round(r.esperaMs / 1000)} s: run piece:publish again then`] };
      case 'desconocida':
        return {
          ok: false,
          lines: [`Attempt ${r.intento}: outcome UNKNOWN${r.agotada ? ' and the attempts are used up; a person must look' : ''}; nothing is resent blindly. Run piece:publish again to look it up by key`],
        };
      case 'fallida':
        return { ok: false, lines: [`Attempt ${r.intento} failed for good (${r.categoria}); the piece is in fallo_publicacion`] };
    }
  } catch (error) {
    return { ok: false, lines: [failure(error)] };
  }
}

/** Collects the NEXT metrics window of a published piece now, as if its time had come. */
export async function runPublishMetrics(deps: PublicacionScriptDeps, args: PiezaArgs): Promise<ScriptResult> {
  try {
    const publicada = await getPublicacionPublicada(deps.db, args.clienteId, args.piezaId);
    if (!publicada) return { ok: false, lines: ['That piece was not published; there is nothing to measure'] };
    const hechas = new Set((await listSnapshotsDePieza(deps.db, args.clienteId, args.piezaId)).map((s) => s.ventana));
    const siguiente = VENTANAS.find((v) => !hechas.has(v));
    if (!siguiente) return { ok: true, lines: ['Every window (24h, 72h, 7d, 28d) already has its snapshot'] };
    // +1 s: JavaScript dates keep milliseconds, the database microseconds, so the exact due instant can fall a hair short.
    const vence = new Date(ventanasDeMedicion(publicada.publicada_en).find((v) => v.ventana === siguiente)!.en.getTime() + 1000);
    const r = await ejecutarRecoleccionMetricas(
      { db: deps.db, storage: deps.storage, provider: deps.provider, queue: new FakePublicacionQueue(), ...(deps.alertas ? { alertas: deps.alertas } : {}) },
      vence,
      { clienteId: args.clienteId, piezaId: args.piezaId, limite: 1, recogidaEn: (deps.now ?? (() => new Date()))() },
    );
    if (r.fallidas > 0) return { ok: false, lines: [`The ${siguiente} window could not be collected (see the log by ids); it stays pending`] };
    const snapshots = await listSnapshotsDePieza(deps.db, args.clienteId, args.piezaId);
    const s = snapshots.find((x) => x.ventana === siguiente);
    if (!s) return { ok: false, lines: [`Nothing was collected for the ${siguiente} window`] };
    return {
      ok: true,
      lines: [
        `Window ${siguiente} collected for piece ${args.piezaId} at ${s.recogida_en.toISOString()}`,
        `  ${Object.entries(s.metricas).map(([k, v]) => `${k}=${v ?? 'null'}`).join(' ')}`,
      ],
    };
  } catch (error) {
    return { ok: false, lines: [failure(error)] };
  }
}
