import { PiezaNotFoundError, PlanDescartadoError } from '../modules/piezas/errors.js';
import { listPiezas } from '../modules/piezas/piezasRepository.js';
import { PlanNoAprobadoError, PlanNotFoundError } from '../modules/planificador/errors.js';
import { getPlan } from '../modules/planificador/planesRepository.js';
import {
  BriefConFaltantesError,
  FormatoNoSoportadoError,
  FuentesMuyPequenasError,
  ImageDecodeError,
  producirPieza,
  ProduccionEstadoInvalidoError,
  ProduccionExistenteError,
  ProduccionHechoVencidoError,
  ProduccionMediaNoUsableError,
  ProduccionObsoletaError,
  SinBriefError,
  TextDoesNotFitError,
  UnsupportedGlyphsError,
  type PiezaProducida,
  type ProduccionDeps,
} from '../modules/produccion/index.js';
import type { PieceProduceArgs } from './pieceProduceArgs.js';

export interface PieceProduceResult {
  ok: boolean;
  /** Lines to print. Only ids, counts, sizes, hashes, paths and error names: NEVER the copy of a piece. */
  lines: string[];
}

export interface PieceProduceDeps extends ProduccionDeps {
  /** For local storage: the absolute path of a stored key, so the developer can open the file. Absent: the key is printed. */
  localPath?: (key: string) => string;
}

function describe(deps: PieceProduceDeps, done: PiezaProducida): string[] {
  const { produccion, pieza } = done;
  const lines = [`Piece ${pieza.id}: production version ${produccion.version} (${pieza.estado}), ${produccion.archivos.length} file(s)`];
  for (const a of produccion.archivos) {
    const where = deps.localPath ? deps.localPath(a.clave_almacenamiento) : a.clave_almacenamiento;
    lines.push(`  ${a.orden}. ${a.ancho}x${a.alto} ${a.mime} ${a.tamano_bytes} bytes sha256 ${a.sha256}`, `     ${where}`);
  }
  lines.push(`  piece hash (${produccion.hash_version}): ${produccion.hash_pieza}`);
  return lines;
}

/**
 * Produces one piece, or every piece of a plan waiting in guion_listo, through the production service
 * (actor sistema) and reports it. A `--plan` run that found nothing to produce counts as a refusal.
 */
export async function runPieceProduce(deps: PieceProduceDeps, args: PieceProduceArgs): Promise<PieceProduceResult> {
  try {
    if (args.modo === 'pieza') {
      const done = await producirPieza(deps, args.clienteId, args.piezaId, { tipo: 'sistema' }, { reproducir: args.reproducir });
      return { ok: true, lines: describe(deps, done) };
    }

    const plan = await getPlan(deps.db, args.clienteId, args.planId);
    if (!plan) throw new PlanNotFoundError();
    if (plan.estado === 'descartado') throw new PlanDescartadoError();
    if (plan.estado !== 'aprobado') throw new PlanNoAprobadoError(plan.estado);
    const piezas = await listPiezas(deps.db, args.clienteId, { planId: plan.id, estado: 'guion_listo' });
    const lines = [`Plan ${plan.id}: ${piezas.length} piece(s) waiting for production`];
    let ok = 0;
    let fallidas = 0;
    for (const pieza of piezas) {
      try {
        lines.push(...describe(deps, await producirPieza(deps, args.clienteId, pieza.id, { tipo: 'sistema' })));
        ok++;
      } catch (error) {
        fallidas++;
        lines.push(`  ${pieza.id} FAILED: ${failureLine(error)}`);
      }
    }
    lines.push(`produced ${ok}, failed ${fallidas}`);
    if (ok === 0 && fallidas === 0) {
      lines.push('Nothing to do: no piece of this plan is waiting for production (use --pieza <id> --reproducir to make a new version).');
      return { ok: false, lines };
    }
    return { ok: fallidas === 0, lines };
  } catch (error) {
    return { ok: false, lines: [failureLine(error)] };
  }
}

function failureLine(error: unknown): string {
  if (error instanceof PlanNotFoundError) return 'That plan does not exist for this client';
  if (error instanceof PiezaNotFoundError) return 'That piece does not exist for this client';
  if (error instanceof PlanNoAprobadoError) return `The plan is not approved (state ${error.estado}); approve it first (npm run plan:approve-internal)`;
  if (error instanceof PlanDescartadoError) return 'The plan is discarded';
  if (error instanceof ProduccionEstadoInvalidoError) return `A piece in state ${error.estado} cannot be produced`;
  if (error instanceof FormatoNoSoportadoError) return `The format ${error.formato} is not produced yet for ${error.red} (video waits for step 7b)`;
  if (error instanceof SinBriefError) return 'The piece has no brief yet (npm run brief:generate)';
  if (error instanceof BriefConFaltantesError) return `The brief has slots without media (slides ${error.ordenes.join(', ')}): upload more media and regenerate the brief`;
  if (error instanceof ProduccionExistenteError) return `The piece already has a production (version ${error.version}). Use --reproducir to make a new version.`;
  if (error instanceof FuentesMuyPequenasError) {
    return `${error.mediaIds.length} source image(s) are too small for slides ${error.ordenes.join(', ')} (media ${error.mediaIds.join(', ')}): regenerate the brief (npm run brief:generate -- --regenerar) or upload larger photos`;
  }
  if (error instanceof ProduccionHechoVencidoError) return `${error.hechoIds.length} fact(s) cited by the brief are no longer valid: regenerate the brief`;
  if (error instanceof ProduccionMediaNoUsableError) return `${error.mediaIds.length} media item(s) of the brief are no longer usable (${error.mediaIds.join(', ')}): regenerate the brief`;
  if (error instanceof ProduccionObsoletaError) return 'The piece changed while it was being produced; nothing was kept: run it again';
  if (error instanceof TextDoesNotFitError) return `The text does not fit the slide (${error.reason}): regenerate the brief`;
  if (error instanceof UnsupportedGlyphsError) return `The on-screen text has ${error.cantidad} character(s) the bundled font cannot draw: regenerate the brief`;
  if (error instanceof ImageDecodeError) return `A source image cannot be used (${error.reason})`;
  return `Production failed (${error instanceof Error ? error.name : 'unknown error'})`;
}
