import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import { inspectMp4 } from '../../lib/media/ffmpeg/mp4Boxes.js';
import type { VideoFacts } from '../../lib/media/ffmpeg/parseVideoFacts.js';
import { probeVideo as defaultProbeVideo } from '../../lib/media/ffmpeg/probeVideo.js';
import { FfmpegRunError, runFfmpeg as defaultRunFfmpeg } from '../../lib/media/ffmpeg/runFfmpeg.js';
import type { FfmpegTooling } from '../../lib/media/ffmpeg/tooling.js';
import { MediaProbeError } from '../../lib/media/probe/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { type CapaTextoAnimado, renderizarCapaEscena } from './capaTexto.js';
import { elegirColores } from './colors.js';
import { CapaTextoError, FuenteDeVideoIlegibleError, RemotionNoDisponibleError, SalidaInvalidaError } from './errors.js';
import { crearMedidor } from './medidor.js';
import { construirPropsPlantilla, type PropsPlantilla } from './propsPlantilla.js';
import { buildFfmpegArgs, DEFAULT_REEL_OUTPUT, type ReelOutputSpec, type ReelOverlayInput } from './reelFfmpegArgs.js';
import { renderReelOverlay } from './reelOverlay.js';
import { buildReelTimeline, REEL_ALTO, REEL_ANCHO, REEL_FPS, type ReelGuionInput, type ReelSourceMeta, type ReelTimeline } from './reelTimeline.js';
import { verifyReelOutput } from './reelVerify.js';

// The reel renderer (Step 7b): real video clips in, one verified MP4 out.
//
//   text overlays (PNG, 7a layout)  ->  download + probe sources  ->  timeline  ->  FFmpeg  ->  verify
//
// REAL MEDIA ONLY: FFmpeg cuts, crops, scales, joins and encodes the client's own clips and overlays
// the PNGs; nothing is generated. Everything happens in a temporary folder of its own that is ALWAYS
// removed. The output file only exists while `alRenderizar` runs, so the caller stores it there.
// With a TEMPLATE (Step 7c) the text overlays are transparent PNG sequences drawn by the CapaTextoAnimado port
// (Remotion) instead of the static PNGs; FFmpeg overlays them the same way, and the timeline, the encoding, the
// metadata stripping and the verification are unchanged. A chosen template never degrades silently: any failure
// of the layer fails the render. FFmpeg's stderr is never logged or returned; the log has the exit code and a fixed category.

export interface ReelRenderDeps {
  storage: Pick<Storage, 'getFile'>;
  /** The once-per-process FFmpeg check (createFfmpegToolingGuard). Called before anything is downloaded. */
  tooling: () => Promise<FfmpegTooling>;
  ffmpegPath: string;
  ffprobePath: string;
  /** Time limit of the FFmpeg render, in ms (config FFMPEG_TIMEOUT_MS). */
  ffmpegTimeoutMs: number;
  /** Time limit of each ffprobe, in ms (config FFPROBE_TIMEOUT_MS). */
  ffprobeTimeoutMs: number;
  logger?: Pick<Logger, 'info' | 'warn'>;
  /** Where the temporary folder is made. Defaults to the system temp folder. */
  tempRoot?: string;
  /** For tests. */
  runFfmpeg?: typeof defaultRunFfmpeg;
  probeVideo?: typeof defaultProbeVideo;
  /** The animated text layer (Remotion adapter). Required when the input names a template. */
  capaTexto?: CapaTextoAnimado;
  /** Time limit of each scene's layer, in ms. */
  capaTimeoutMs?: number;
}

const CAPA_TIMEOUT_POR_DEFECTO_MS = 120_000;

export interface ReelRenderInput {
  guion: ReelGuionInput;
  /** Storage key of each source clip, by media id. */
  fuentes: Readonly<Record<string, string>>;
  /** The profile's kit_visual (read only for its brand colors). */
  kitVisual: unknown;
  fuente?: string;
  /** The animated template to draw the text with (id and version from the registry). Absent: the 7b PNG overlays. */
  plantilla?: { id: string; version: number };
  /** Overrides of the encoding values (tests). The tone-mapping capability always comes from the tooling check. */
  outputSpec?: Partial<Omit<ReelOutputSpec, 'hdrToneMap'>>;
}

export interface ReelRenderResult {
  /** The MP4. It exists only while `alRenderizar` runs. */
  ruta: string;
  sha256: Buffer;
  tamano: number;
  /** What ffprobe reports about the output (already verified). */
  facts: VideoFacts;
  timeline: ReelTimeline;
  /** The template the text was drawn with, or null for the PNG overlays. */
  plantilla: { id: string; version: number } | null;
}

async function hashFile(filePath: string): Promise<Buffer> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest();
}

/**
 * Renders the reel of `input` and calls `alRenderizar` with the verified file; returns what it returns.
 * The temporary folder is removed afterwards, whether it succeeded, failed or timed out.
 *
 * Throws, before or without producing a file: TextDoesNotFitError / UnsupportedGlyphsError (text),
 * FfmpegToolingError, FuenteDeVideoIlegibleError, the timeline's typed refusals (no video, marks,
 * long scene, FuentesMuyPequenasError, total duration), HdrNoSoportadoError, FfmpegRunError and
 * SalidaInvalidaError.
 */
export async function renderReel<T>(deps: ReelRenderDeps, input: ReelRenderInput, alRenderizar: (resultado: ReelRenderResult) => Promise<T>): Promise<T> {
  const log = deps.logger;
  const run = deps.runFfmpeg ?? defaultRunFfmpeg;
  const probe = deps.probeVideo ?? defaultProbeVideo;
  const probeOptions = { ffprobePath: deps.ffprobePath, timeoutMs: deps.ffprobeTimeoutMs };

  // 1. Cheap refusals first, before a byte is downloaded: FFmpeg capabilities, then the text of every scene.
  const tooling = await deps.tooling();
  const plantilla = input.plantilla ?? null;
  const overlays = new Map<number, Buffer>();
  const propsDe = new Map<number, PropsPlantilla>();
  if (plantilla === null) {
    for (const escena of input.guion.contenido.escenas) {
      const overlay = renderReelOverlay(escena.texto_en_pantalla, input.kitVisual, input.fuente);
      if (overlay) overlays.set(escena.orden, overlay.png);
    }
  } else {
    if (!deps.capaTexto) throw new RemotionNoDisponibleError('paquete_ausente');
    // The props of every scene (glyphs, fit, word timing) are checked here, before anything is downloaded. The
    // frames of a scene are the same number the timeline will compute from its duration.
    const colores = elegirColores(input.kitVisual);
    const medir = crearMedidor(input.fuente);
    for (const escena of input.guion.contenido.escenas) {
      const fotogramas = typeof escena.duracion_s === 'number' && Number.isFinite(escena.duracion_s) ? Math.round(escena.duracion_s * REEL_FPS) : 0;
      if (fotogramas < 1) continue; // the timeline refuses this scene with its own typed error
      const props = construirPropsPlantilla({ plantilla, escena: { orden: escena.orden, texto: escena.texto_en_pantalla, fotogramas }, fps: REEL_FPS, colores, ancho: REEL_ANCHO, alto: REEL_ALTO, medir });
      if (props) propsDe.set(escena.orden, props);
    }
  }

  const carpeta = await mkdtemp(path.join(deps.tempRoot ?? os.tmpdir(), 'novaciel-reel-'));
  try {
    // 2. Sources: download by streaming, then probe what is really there.
    const mediaIds = [...new Set(input.guion.tomas.flatMap((t) => (t.fuente === 'media_real' && t.media_id !== null && input.fuentes[t.media_id] !== undefined ? [t.media_id] : [])))];
    const rutasFuente: Record<string, string> = {};
    const meta: Record<string, ReelSourceMeta> = {};
    for (const [i, mediaId] of mediaIds.entries()) {
      const ruta = path.join(carpeta, `fuente-${i + 1}`);
      await deps.storage.getFile(input.fuentes[mediaId]!, ruta);
      let facts: VideoFacts;
      try {
        facts = await probe(ruta, probeOptions);
      } catch (error) {
        if (error instanceof MediaProbeError && (error.code === 'parse' || error.code === 'exit_nonzero')) throw new FuenteDeVideoIlegibleError(mediaId, 'no_se_pudo_leer');
        throw error;
      }
      if (!facts.video) throw new FuenteDeVideoIlegibleError(mediaId, 'sin_video');
      const duracionMs = facts.duracionMs ?? facts.video.duracionMs;
      if (duracionMs === null || duracionMs <= 0 || facts.video.fps === null) throw new FuenteDeVideoIlegibleError(mediaId, 'no_se_pudo_leer');
      rutasFuente[mediaId] = ruta;
      meta[mediaId] = { ancho: facts.video.ancho, alto: facts.video.alto, duracionMs, fps: facts.video.fps, hdr: facts.video.hdr };
    }

    // 3. Timeline, overlays on disk, arguments.
    const timeline = buildReelTimeline(input.guion, meta);
    const rutasOverlay: Record<number, ReelOverlayInput> = {};
    let msRemotion = 0;
    for (const segmento of timeline.segmentos) {
      if (!segmento.overlay) continue;
      if (plantilla === null) {
        const ruta = path.join(carpeta, `ov-${segmento.escena}.png`);
        await writeFile(ruta, overlays.get(segmento.escena)!);
        rutasOverlay[segmento.escena] = ruta;
        continue;
      }
      // One layer per scene with text, in a folder of its own inside the temp folder (removed with it).
      const props = propsDe.get(segmento.escena);
      if (!props || props.fotogramas !== segmento.frames) throw new CapaTextoError('salida_incompleta');
      const inicio = Date.now();
      const capa = await renderizarCapaEscena(
        deps.capaTexto!,
        { plantilla: plantilla.id, version: plantilla.version, props, ancho: timeline.ancho, alto: timeline.alto, fps: REEL_FPS, fotogramas: segmento.frames },
        { carpeta: path.join(carpeta, `capa-${segmento.escena}`), timeoutMs: deps.capaTimeoutMs ?? CAPA_TIMEOUT_POR_DEFECTO_MS },
      );
      msRemotion += Date.now() - inicio;
      if (!capa || capa.fotogramas !== segmento.frames) throw new CapaTextoError('salida_incompleta');
      rutasOverlay[segmento.escena] = { carpeta: capa.carpeta, patron: capa.patron };
    }
    const salida = path.join(carpeta, 'salida.mp4');
    const args = buildFfmpegArgs(timeline, { fuentes: rutasFuente, overlays: rutasOverlay, salida }, { ...DEFAULT_REEL_OUTPUT, ...input.outputSpec, hdrToneMap: tooling.hdr });

    // 4. Render.
    try {
      await run(args, { ffmpegPath: deps.ffmpegPath, timeoutMs: deps.ffmpegTimeoutMs });
    } catch (error) {
      if (error instanceof FfmpegRunError) log?.warn({ categoria: error.categoria, exitCode: error.exitCode ?? null, escenas: timeline.segmentos.length }, 'reel render failed');
      throw error;
    }

    // 5. Verify the file as it really is.
    let tamano: number;
    try {
      tamano = (await stat(salida)).size;
    } catch {
      throw new SalidaInvalidaError('salida_no_creada');
    }
    let facts: VideoFacts;
    try {
      facts = await probe(salida, probeOptions);
    } catch (error) {
      if (error instanceof MediaProbeError && (error.code === 'parse' || error.code === 'exit_nonzero')) throw new SalidaInvalidaError('formato_contenedor');
      throw error;
    }
    const layout = await inspectMp4(salida);
    try {
      verifyReelOutput({ facts, layout, timeline, tamanoBytes: tamano });
    } catch (error) {
      if (error instanceof SalidaInvalidaError) log?.warn({ razon: error.razon, detalle: error.detalle ?? null }, 'reel output rejected');
      throw error;
    }
    const sha256 = await hashFile(salida);
    log?.info({ escenas: timeline.segmentos.length, fotogramas: timeline.totalFrames, tamanoBytes: tamano, overlays: plantilla === null ? overlays.size : propsDe.size, plantilla: plantilla?.id ?? null, plantillaVersion: plantilla?.version ?? null, remotionMs: msRemotion }, 'reel rendered');

    return await alRenderizar({ ruta: salida, sha256, tamano, facts, timeline, plantilla });
  } finally {
    await rm(carpeta, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
