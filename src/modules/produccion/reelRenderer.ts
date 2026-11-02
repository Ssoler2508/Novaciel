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
import { CapaTextoError, FuenteDeVideoIlegibleError, RemotionNoDisponibleError, SalidaInvalidaError, SonoridadFueraDeRangoError, VocesSinPlantillaError, VozSilenciosaError } from './errors.js';
import { crearMedidor } from './medidor.js';
import { construirPropsPlantilla, type PropsPlantilla } from './propsPlantilla.js';
import { buildAudioMezclaArgs, buildFfmpegArgs, DEFAULT_REEL_OUTPUT, type ReelOutputSpec, type ReelOverlayInput } from './reelFfmpegArgs.js';
import { renderReelOverlay } from './reelOverlay.js';
import { buildReelTimeline, REEL_ALTO, REEL_ANCHO, REEL_FPS, type ReelGuionInput, type ReelSourceMeta, type ReelTimeline } from './reelTimeline.js';
import { verifyReelOutput } from './reelVerify.js';
import { calcularGanancia, juzgarSonoridad } from './sonoridadVoz.js';
import type { TiempoPalabra } from './tiemposPalabras.js';
import { medirSonoridad as medirSonoridadReal, type Sonoridad } from '../../lib/media/ffmpeg/medirSonoridad.js';

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
  /** For tests. */
  medirSonoridad?: (filePath: string, options: { ffmpegPath: string; timeoutMs: number }) => Promise<Sonoridad>;
}

/** The voice-over of one scene, ready to mix and to subtitle (Step 7d). */
export interface VozDeReel {
  /** Scene number, from 1. */
  escena: number;
  /** Storage key of the audio file. */
  clave: string;
  /** Where the voice starts inside the scene, ms. */
  entradaMs: number;
  /** The SPOKEN text: it is the subtitle of the scene, and replaces the on-screen text there. */
  texto: string;
  /** The real time of each spoken word, ms from the start of the scene. */
  tiempos: readonly TiempoPalabra[];
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
  /**
   * The voice-overs by scene (Step 7d). Needs a template: the spoken text is drawn as subtitles with the voice's
   * real times, and the on-screen text of a voiced scene is not drawn. The track is mixed, measured and brought
   * to the target loudness with one static gain.
   */
  voces?: readonly VozDeReel[];
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
  /** The voice-over mix (numbers only), or null for a silent reel. */
  voz: { escenas: readonly number[]; mezclaLufs: number; gananciaDb: number; finalLufs: number; picoVerdaderoDbtp: number | null } | null;
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
  const voces = input.voces ?? [];
  if (voces.length > 0 && plantilla === null) throw new VocesSinPlantillaError();
  const vozPorEscena = new Map(voces.map((v) => [v.escena, v]));
  // A voiced scene shows its SPOKEN text (the subtitles); its on-screen text is not drawn.
  const guion: ReelGuionInput =
    voces.length === 0
      ? input.guion
      : { ...input.guion, contenido: { ...input.guion.contenido, escenas: input.guion.contenido.escenas.map((e) => (vozPorEscena.has(e.orden) ? { ...e, texto_en_pantalla: vozPorEscena.get(e.orden)!.texto } : e)) } };
  const overlays = new Map<number, Buffer>();
  const propsDe = new Map<number, PropsPlantilla>();
  if (plantilla === null) {
    for (const escena of guion.contenido.escenas) {
      const overlay = renderReelOverlay(escena.texto_en_pantalla, input.kitVisual, input.fuente);
      if (overlay) overlays.set(escena.orden, overlay.png);
    }
  } else {
    if (!deps.capaTexto) throw new RemotionNoDisponibleError('paquete_ausente');
    // The props of every scene (glyphs, fit, word timing) are checked here, before anything is downloaded. The
    // frames of a scene are the same number the timeline will compute from its duration.
    const colores = elegirColores(input.kitVisual);
    const medir = crearMedidor(input.fuente);
    for (const escena of guion.contenido.escenas) {
      const fotogramas = typeof escena.duracion_s === 'number' && Number.isFinite(escena.duracion_s) ? Math.round(escena.duracion_s * REEL_FPS) : 0;
      if (fotogramas < 1) continue; // the timeline refuses this scene with its own typed error
      const voz = vozPorEscena.get(escena.orden);
      const props = construirPropsPlantilla({
        plantilla,
        escena: { orden: escena.orden, texto: escena.texto_en_pantalla, fotogramas },
        ...(voz ? { tiempos: voz.tiempos } : {}),
        fps: REEL_FPS,
        colores,
        ancho: REEL_ANCHO,
        alto: REEL_ALTO,
        medir,
      });
      if (props) propsDe.set(escena.orden, props);
    }
  }

  const carpeta = await mkdtemp(path.join(deps.tempRoot ?? os.tmpdir(), 'novaciel-reel-'));
  try {
    // 2. Sources: download by streaming, then probe what is really there.
    const mediaIds = [...new Set(guion.tomas.flatMap((t) => (t.fuente === 'media_real' && t.media_id !== null && input.fuentes[t.media_id] !== undefined ? [t.media_id] : [])))];
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

    // The voice-over files, streamed like the sources.
    const rutasVoz: Record<number, { ruta: string; entradaMs: number }> = {};
    for (const voz of voces) {
      const extension = /\.([A-Za-z0-9]{1,5})$/.exec(voz.clave)?.[1] ?? 'audio';
      const ruta = path.join(carpeta, `voz-${voz.escena}.${extension}`);
      await deps.storage.getFile(voz.clave, ruta);
      rutasVoz[voz.escena] = { ruta, entradaMs: voz.entradaMs };
    }

    // 3. Timeline, overlays on disk, arguments.
    const timeline = buildReelTimeline(guion, meta);
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

    // The voice track: mix it alone, measure it, and bring it to the target with ONE static gain.
    const medir = deps.medirSonoridad ?? medirSonoridadReal;
    let gananciaDb = 0;
    let mezclaLufs = 0;
    if (voces.length > 0) {
      const mezcla = path.join(carpeta, 'mezcla.wav');
      try {
        await run(buildAudioMezclaArgs(timeline, { voces: rutasVoz, salida: mezcla }), { ffmpegPath: deps.ffmpegPath, timeoutMs: deps.ffmpegTimeoutMs });
      } catch (error) {
        if (error instanceof FfmpegRunError) log?.warn({ categoria: error.categoria, exitCode: error.exitCode ?? null }, 'voice mix failed');
        throw error;
      }
      const medida = await medir(mezcla, { ffmpegPath: deps.ffmpegPath, timeoutMs: deps.ffmpegTimeoutMs });
      const ganancia = calcularGanancia(medida.integradaLufs);
      if (ganancia === null) throw new VozSilenciosaError(medida.integradaLufs);
      gananciaDb = ganancia;
      mezclaLufs = medida.integradaLufs;
    }
    const args = buildFfmpegArgs(
      timeline,
      { fuentes: rutasFuente, overlays: rutasOverlay, salida, ...(voces.length > 0 ? { voces: rutasVoz, gananciaDb } : {}) },
      { ...DEFAULT_REEL_OUTPUT, ...input.outputSpec, hdrToneMap: tooling.hdr },
    );

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
    // With a voice, the reel as it is must be audible and inside the loudness range (measured on the file).
    let voz: ReelRenderResult['voz'] = null;
    if (voces.length > 0) {
      const final = await medir(salida, { ffmpegPath: deps.ffmpegPath, timeoutMs: deps.ffmpegTimeoutMs });
      const juicio = juzgarSonoridad(final);
      if (juicio === 'silencio') throw new VozSilenciosaError(final.integradaLufs);
      if (juicio !== 'en_rango') throw new SonoridadFueraDeRangoError(final.integradaLufs, final.picoVerdaderoDbtp);
      voz = { escenas: voces.map((v) => v.escena), mezclaLufs, gananciaDb, finalLufs: final.integradaLufs, picoVerdaderoDbtp: final.picoVerdaderoDbtp };
    }
    const sha256 = await hashFile(salida);
    log?.info(
      { escenas: timeline.segmentos.length, fotogramas: timeline.totalFrames, tamanoBytes: tamano, overlays: plantilla === null ? overlays.size : propsDe.size, plantilla: plantilla?.id ?? null, plantillaVersion: plantilla?.version ?? null, remotionMs: msRemotion, ...(voz ? { voces: voz.escenas.length, mezclaLufs: voz.mezclaLufs, gananciaDb: voz.gananciaDb, finalLufs: voz.finalLufs } : {}) },
      'reel rendered',
    );

    return await alRenderizar({ ruta: salida, sha256, tamano, facts, timeline, plantilla, voz });
  } finally {
    await rm(carpeta, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
