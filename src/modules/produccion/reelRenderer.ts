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
import { FuenteDeVideoIlegibleError, SalidaInvalidaError } from './errors.js';
import { buildFfmpegArgs, DEFAULT_REEL_OUTPUT, type ReelOutputSpec } from './reelFfmpegArgs.js';
import { renderReelOverlay } from './reelOverlay.js';
import { buildReelTimeline, type ReelGuionInput, type ReelSourceMeta, type ReelTimeline } from './reelTimeline.js';
import { verifyReelOutput } from './reelVerify.js';

// The reel renderer (Step 7b): real video clips in, one verified MP4 out.
//
//   text overlays (PNG, 7a layout)  ->  download + probe sources  ->  timeline  ->  FFmpeg  ->  verify
//
// REAL MEDIA ONLY: FFmpeg cuts, crops, scales, joins and encodes the client's own clips and overlays
// the PNGs; nothing is generated. Everything happens in a temporary folder of its own that is ALWAYS
// removed. The output file only exists while `alRenderizar` runs, so the caller stores it there.
// FFmpeg's stderr is never logged or returned; the log has the exit code and a fixed category.

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
}

export interface ReelRenderInput {
  guion: ReelGuionInput;
  /** Storage key of each source clip, by media id. */
  fuentes: Readonly<Record<string, string>>;
  /** The profile's kit_visual (read only for its brand colors). */
  kitVisual: unknown;
  fuente?: string;
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
  const overlays = new Map<number, Buffer>();
  for (const escena of input.guion.contenido.escenas) {
    const overlay = renderReelOverlay(escena.texto_en_pantalla, input.kitVisual, input.fuente);
    if (overlay) overlays.set(escena.orden, overlay.png);
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
    const rutasOverlay: Record<number, string> = {};
    for (const segmento of timeline.segmentos) {
      if (!segmento.overlay) continue;
      const ruta = path.join(carpeta, `ov-${segmento.escena}.png`);
      await writeFile(ruta, overlays.get(segmento.escena)!);
      rutasOverlay[segmento.escena] = ruta;
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
    log?.info({ escenas: timeline.segmentos.length, fotogramas: timeline.totalFrames, tamanoBytes: tamano, overlays: overlays.size }, 'reel rendered');

    return await alRenderizar({ ruta: salida, sha256, tamano, facts, timeline });
  } finally {
    await rm(carpeta, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
