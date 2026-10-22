import { FfmpegRunError } from '../lib/media/ffmpeg/runFfmpeg.js';
import { FfmpegToolingError } from '../lib/media/ffmpeg/tooling.js';
import { PiezaNotFoundError, PlanDescartadoError } from '../modules/piezas/errors.js';
import { listPiezas } from '../modules/piezas/piezasRepository.js';
import { PlanNoAprobadoError, PlanNotFoundError } from '../modules/planificador/errors.js';
import { getPlan } from '../modules/planificador/planesRepository.js';
import {
  BriefConFaltantesError,
  CapaTextoError,
  RemotionLicenciaNoConfiguradaError,
  RemotionNoDisponibleError,
  DuracionTotalFueraDeRangoError,
  EscenaMasLargaQueLaFuenteError,
  EscenaSinVideoError,
  FormatoNoSoportadoError,
  FuenteDeVideoIlegibleError,
  FuentesMuyPequenasError,
  HdrNoSoportadoError,
  ImageDecodeError,
  MarcasFueraDeRangoError,
  producirPieza,
  ProduccionEstadoInvalidoError,
  ProduccionExistenteError,
  ProduccionHechoVencidoError,
  ProduccionMediaNoUsableError,
  ProduccionObsoletaError,
  ReelNoConfiguradoError,
  SalidaInvalidaError,
  SinBriefError,
  TextDoesNotFitError,
  TimelineInvalidoError,
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
    lines.push(`  ${a.orden}. ${a.ancho}x${a.alto} ${a.mime} ${a.tamano_bytes} bytes sha256 ${a.sha256}`);
    if (a.duracion_ms !== null) {
      lines.push(`     template: ${produccion.plantilla === null ? 'none (PNG overlays)' : `${produccion.plantilla} v${produccion.plantilla_version}`}`);
      lines.push(`     video: ${(a.duracion_ms / 1000).toFixed(1)} s, ${a.fps} fps, ${a.codec_video}/${a.codec_audio}`);
      for (const f of a.fuentes) lines.push(`     scene ${f.escena}: media ${f.media_id} ${f.entrada_ms}-${f.salida_ms} ms`);
    }
    lines.push(`     ${where}`);
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

export function failureLine(error: unknown): string {
  if (error instanceof PlanNotFoundError) return 'That plan does not exist for this client';
  if (error instanceof PiezaNotFoundError) return 'That piece does not exist for this client';
  if (error instanceof PlanNoAprobadoError) return `The plan is not approved (state ${error.estado}); the client must approve it first`;
  if (error instanceof PlanDescartadoError) return 'The plan is discarded';
  if (error instanceof ProduccionEstadoInvalidoError) return `A piece in state ${error.estado} cannot be produced`;
  if (error instanceof FormatoNoSoportadoError) return `The format ${error.formato} has no defined size for ${error.red}, so it cannot be produced`;
  if (error instanceof SinBriefError) return 'The piece has no brief yet (npm run brief:generate)';
  if (error instanceof BriefConFaltantesError) return `The brief has slots without media (slides ${error.ordenes.join(', ')}): upload more media and regenerate the brief`;
  if (error instanceof ProduccionExistenteError) return `The piece already has a production (version ${error.version}). Use --reproducir to make a new version.`;
  if (error instanceof FuentesMuyPequenasError) {
    return `${error.mediaIds.length} source image(s) are too small for slides or scenes ${error.ordenes.join(', ')} (media ${error.mediaIds.join(', ')}): regenerate the brief (npm run brief:generate -- --regenerar) or upload larger photos or videos`;
  }
  if (error instanceof ProduccionHechoVencidoError) return `${error.hechoIds.length} fact(s) cited by the brief are no longer valid: regenerate the brief`;
  if (error instanceof ProduccionMediaNoUsableError) return `${error.mediaIds.length} media item(s) of the brief are no longer usable (${error.mediaIds.join(', ')}): regenerate the brief`;
  if (error instanceof ProduccionObsoletaError) return 'The piece changed while it was being produced; nothing was kept: run it again';
  if (error instanceof TextDoesNotFitError) return `The text does not fit the slide (${error.reason}): regenerate the brief`;
  if (error instanceof UnsupportedGlyphsError) return `The on-screen text has ${error.cantidad} character(s) the bundled font cannot draw: regenerate the brief`;
  if (error instanceof ImageDecodeError) return `A source image cannot be used (${error.reason})`;
  // Reels (Step 7b). Scene numbers, media ids, sizes and fixed reasons only: never the text, a path or FFmpeg's output.
  if (error instanceof TimelineInvalidoError) return `The reel scenes are not valid (${error.reason}): regenerate the brief`;
  if (error instanceof EscenaSinVideoError) return `Scenes ${error.escenas.join(', ')} have no video: upload videos and regenerate the brief (npm run brief:generate -- --regenerar)`;
  if (error instanceof MarcasFueraDeRangoError) return `Scenes ${error.escenas.join(', ')} have in/out marks outside their video: regenerate the brief`;
  if (error instanceof EscenaMasLargaQueLaFuenteError) return `Scenes ${error.escenas.join(', ')} last longer than the part of their video that can be used: regenerate the brief or upload longer videos`;
  if (error instanceof DuracionTotalFueraDeRangoError) return `The reel would last ${error.totalMs} ms; it must last ${error.minMs} to ${error.maxMs} ms: regenerate the brief`;
  if (error instanceof HdrNoSoportadoError) return `Scenes ${error.escenas.join(', ')} are HDR and this FFmpeg has no zscale/tonemap to convert them: install a full FFmpeg build or use SDR videos`;
  if (error instanceof FuenteDeVideoIlegibleError) return `The source video ${error.mediaId} cannot be used (${error.razon}): upload it again or regenerate the brief`;
  if (error instanceof SalidaInvalidaError) return `The rendered reel was refused and nothing was kept (${error.razon}${error.detalle === undefined ? '' : `: ${error.detalle}`})`;
  if (error instanceof FfmpegRunError) return `FFmpeg failed (${error.categoria}${error.exitCode === undefined ? '' : `, exit code ${error.exitCode}`}); nothing was kept`;
  if (error instanceof FfmpegToolingError) return `${error.message} (check FFMPEG_PATH and FFPROBE_PATH, see .env.example)`;
  // Animated text (Step 7c): fixed messages only, never the text.
  if (error instanceof RemotionLicenciaNoConfiguradaError) return 'Remotion is disabled: REMOTION_LICENCIA is not set (see docs/ADR-06_REMOTION_LICENCIA.md)';
  if (error instanceof RemotionNoDisponibleError) return `The animated text engine is not available (${error.razon}); run npm run remotion:browser once (needs the network) and check REMOTION_NAVEGADOR`;
  if (error instanceof CapaTextoError) return `The animated text layer could not be rendered (${error.razon}); nothing was kept`;
  if (error instanceof ReelNoConfiguradoError) return 'Reel production is not configured in this process';
  return `Production failed (${error instanceof Error ? error.name : 'unknown error'})`;
}
