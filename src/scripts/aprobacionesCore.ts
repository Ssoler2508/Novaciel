import type { Db } from '../db/types.js';
import type { Storage } from '../lib/media/storage/types.js';
import * as aprobaciones from '../modules/aprobaciones/index.js';
import type { AprobadorActor, AvisoEncolado, Recordatorios } from '../modules/aprobaciones/index.js';
import { InvalidTransitionError, PiezaNotFoundError, PlanDescartadoError } from '../modules/piezas/errors.js';
import { PlanNoAprobadoError, PlanNotFoundError } from '../modules/planificador/errors.js';
import { getPlan } from '../modules/planificador/planesRepository.js';
import { ProduccionHechoVencidoError, ProduccionMediaNoUsableError } from '../modules/produccion/errors.js';
import { getUserRoles } from '../modules/roles/usuarioRolesRepository.js';
import { getUsuarioByEmail } from '../modules/usuarios/usuariosRepository.js';
import type { PieceApproveArgs, PiecePublicableArgs, PieceReopenArgs, PlanApproveArgs } from './aprobacionesArgs.js';
import { SEED_ADMIN_EMAIL, SEED_APPROVER_EMAIL } from './seedDevelopment.js';

// The cores of the Step 9 development scripts. They print ids, states, hashes and error names only:
// NEVER the copy of a piece or a comment. They enqueue reminders through the `recordatorios` port; no
// worker runs inside a script, so the jobs wait in the queue for the server to deliver them.

export interface ScriptResult {
  ok: boolean;
  lines: string[];
}

export interface AprobacionesScriptDeps {
  db: Db;
  /** The pg-boss port. Absent: nothing is queued (tests with no queue). */
  recordatorios?: Recordatorios;
  /** Lists the reminder jobs queued for an approval target, to print them. */
  avisos?: (objetoId: string) => Promise<AvisoEncolado[]>;
}

/** An existing, active user and its REAL roles from the database. */
async function actorPorEmail(db: Db, email: string): Promise<AprobadorActor | null> {
  const user = await getUsuarioByEmail(db, email);
  if (!user || !user.activo) return null;
  return { usuarioId: user.id, roles: await getUserRoles(db, user.id) };
}

async function lineasAvisos(deps: AprobacionesScriptDeps, objetoId: string, que: string): Promise<string[]> {
  if (!deps.avisos) return [];
  const avisos = await deps.avisos(objetoId);
  if (avisos.length === 0) return [`${que}: no reminder jobs queued (the deadline is too close, or no queue)`];
  return [`${que}: ${avisos.length} reminder job(s) queued`, ...avisos.map((a) => `  ${a.aviso} at ${a.cuando.toISOString()} (${a.estado}) job ${a.jobId}`)];
}

function failure(error: unknown): string {
  if (error instanceof aprobaciones.PermisoDenegadoError) return `Refused: that user may not do this (${error.accion})`;
  if (error instanceof PlanNotFoundError) return 'That plan does not exist for this client';
  if (error instanceof PiezaNotFoundError) return 'That piece does not exist for this client';
  if (error instanceof PlanDescartadoError) return 'The plan is discarded';
  if (error instanceof PlanNoAprobadoError) return `The plan is not approved (state ${error.estado}); the client must approve it first`;
  if (error instanceof aprobaciones.HashDesactualizadoError) return 'The piece changed while the approval was recorded; run it again';
  if (error instanceof aprobaciones.HuellaDesactualizadaError) return 'The plan changed while the approval was recorded; run it again';
  if (error instanceof aprobaciones.PiezaEstadoNoDecidibleError) return `A piece in state ${error.estado} cannot get a ${error.nivel} decision`;
  if (error instanceof aprobaciones.SinProduccionError) return 'The piece has no production yet (npm run piece:produce)';
  if (error instanceof aprobaciones.PlanNoProponibleError) return `The plan cannot be proposed from state ${error.estado}`;
  if (error instanceof aprobaciones.PlanNoDecidibleError) return `The plan cannot be decided on in state ${error.estado}`;
  if (error instanceof InvalidTransitionError) return 'The piece cannot move that way from its current state';
  if (error instanceof aprobaciones.PiezaNoPublicableError) return `NOT PUBLICABLE: ${error.name} (state ${error.estado}, plan ${error.planEstado})`;
  if (error instanceof aprobaciones.SinAprobacionVigenteError) return `NOT PUBLICABLE: ${error.name} (${error.estadoAprobacion})`;
  if (error instanceof aprobaciones.ControlCalidadNoAprobadoError) return `NOT PUBLICABLE: ${error.name} (${error.estadoQc})`;
  if (error instanceof aprobaciones.ArchivoAlteradoError) return `NOT PUBLICABLE: ${error.name} (file ${error.orden}, ${error.motivo})`;
  if (error instanceof aprobaciones.HashPiezaNoCoincideError) return `NOT PUBLICABLE: ${error.name} (production ${error.produccionId}, against the ${error.contra} hash)`;
  if (error instanceof ProduccionHechoVencidoError) return `NOT PUBLICABLE: ${error.name} (${error.hechoIds.length} fact(s): ${error.hechoIds.join(', ')})`;
  if (error instanceof ProduccionMediaNoUsableError) return `NOT PUBLICABLE: ${error.name} (${error.mediaIds.length} media: ${error.mediaIds.join(', ')})`;
  return `Failed (${error instanceof Error ? error.name : 'unknown error'})`;
}

const NO_ADMIN = `The seeded NovaCiel administrator (${SEED_ADMIN_EMAIL}) does not exist or is inactive: run npm run seed`;
const NO_APROBADOR = `The seeded client approver (${SEED_APPROVER_EMAIL}) does not exist or is inactive: run npm run seed`;

const conPuerto = (deps: AprobacionesScriptDeps) => ({ db: deps.db, ...(deps.recordatorios ? { recordatorios: deps.recordatorios } : {}) });

/**
 * Replaces the old internal plan approval. NovaCiel (the seeded administrator) proposes the plan if it is
 * a draft; then the plan is approved AS THE SEEDED FICTIONAL CLIENT APPROVER, with the fingerprint read
 * here. Never a NovaCiel user at the client level.
 */
export async function runPlanApprove(deps: AprobacionesScriptDeps, args: PlanApproveArgs): Promise<ScriptResult> {
  try {
    const admin = await actorPorEmail(deps.db, SEED_ADMIN_EMAIL);
    const aprobador = await actorPorEmail(deps.db, SEED_APPROVER_EMAIL);
    if (!admin) return { ok: false, lines: [NO_ADMIN] };
    if (!aprobador) return { ok: false, lines: [NO_APROBADOR] };
    const plan = await getPlan(deps.db, args.clienteId, args.planId);
    if (!plan) throw new PlanNotFoundError();
    const lines: string[] = [];
    if (plan.estado === 'borrador') {
      const propuesto = await aprobaciones.proponerPlan(conPuerto(deps), args.clienteId, args.planId, admin);
      lines.push(`Plan ${propuesto.plan.id} proposed by NovaCiel (${propuesto.piezas.length} piece(s))`);
      lines.push(...(await lineasAvisos(deps, args.planId, 'Plan reminders')));
    }
    const huella = await aprobaciones.getHuellaPlan(deps.db, args.clienteId, args.planId);
    const hecho = await aprobaciones.decidirPlan(conPuerto(deps), args.clienteId, args.planId, aprobador, {
      decision: 'aprobado',
      huellaVista: huella,
      dispositivo: 'script · desarrollo',
    });
    lines.push(`Plan ${hecho.plan.id} approved by the client approver (${hecho.plan.estado}); fingerprint ${huella}`);
    lines.push(`${hecho.piezas.length} piece(s) moved to plan_aprobado`);
    for (const p of hecho.piezas) lines.push(`  ${p.id} ${p.estado}`);
    return { ok: true, lines };
  } catch (error) {
    return { ok: false, lines: [failure(error)] };
  }
}

/** Records an approval of the CURRENT production as `--como`, with the hash read here. */
export async function runPieceApprove(deps: AprobacionesScriptDeps, args: PieceApproveArgs): Promise<ScriptResult> {
  try {
    const actor = await actorPorEmail(deps.db, args.como);
    if (!actor) return { ok: false, lines: ['That user does not exist or is inactive'] };
    const actual = await aprobaciones.getProduccionActualBasica(deps.db, args.clienteId, args.piezaId);
    if (!actual) throw new aprobaciones.SinProduccionError();
    const hash = Buffer.from(actual.hashPieza).toString('hex');
    const hecho = await aprobaciones.registrarDecision(conPuerto(deps), args.clienteId, args.piezaId, actor, {
      nivel: args.nivel,
      decision: 'aprobada',
      hashVisto: hash,
      dispositivo: 'script · desarrollo',
    });
    const lines = [
      `Piece ${args.piezaId}: ${args.nivel} approval recorded (${hecho.aprobacion.id}) for production version ${actual.version}, hash ${hash}`,
      `  piece state: ${hecho.pieza.estado}; approval state: ${hecho.estadoAprobacion.estado}`,
    ];
    if (hecho.pieza.estado === 'esperando_aprobacion') lines.push(...(await lineasAvisos(deps, args.piezaId, 'Reminders for the client')));
    return { ok: true, lines };
  } catch (error) {
    return { ok: false, lines: [failure(error)] };
  }
}

/** NovaCiel (the seeded administrator) pulls an approved or scheduled piece back to con_cambios. */
export async function runPieceReopen(deps: AprobacionesScriptDeps, args: PieceReopenArgs): Promise<ScriptResult> {
  try {
    const admin = await actorPorEmail(deps.db, SEED_ADMIN_EMAIL);
    if (!admin) return { ok: false, lines: [NO_ADMIN] };
    const pieza = await aprobaciones.reabrirPieza({ db: deps.db }, args.clienteId, args.piezaId, admin, args.motivo);
    return {
      ok: true,
      lines: [`Piece ${pieza.id} is ${pieza.estado} again; produce the next version: npm run piece:produce -- --cliente ${args.clienteId} --pieza ${pieza.id} --reproducir`],
    };
  } catch (error) {
    return { ok: false, lines: [failure(error)] };
  }
}

/** Read-only call of the publish gate. */
export async function runPiecePublicable(deps: { db: Db; storage: Storage }, args: PiecePublicableArgs): Promise<ScriptResult> {
  try {
    const ok = await aprobaciones.assertPublicable(deps, args.clienteId, args.piezaId);
    return { ok: true, lines: [`PUBLICABLE: piece ${args.piezaId}, production ${ok.produccionId} version ${ok.version}, hash ${ok.hashPieza}`] };
  } catch (error) {
    return { ok: false, lines: [failure(error)] };
  }
}
