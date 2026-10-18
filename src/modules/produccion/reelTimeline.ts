import { LIMITES_FORMATO } from '../directorCreativo/limits.js';
import { computeCoverCrop } from './crop.js';
import {
  DuracionTotalFueraDeRangoError,
  EscenaMasLargaQueLaFuenteError,
  EscenaSinVideoError,
  FuentesMuyPequenasError,
  MarcasFueraDeRangoError,
  SourceTooSmallError,
  TimelineInvalidoError,
} from './errors.js';

// The timeline of a reel (Step 7b): from the scenes of the brief and the probed facts of each source
// clip, the exact segments FFmpeg must cut. PURE: no process, no file, no database. The on-screen text
// is read only to know whether it is empty (an empty text gives no overlay); it is never copied into
// the timeline, so nothing a client wrote can reach an FFmpeg argument through here.

/** Constant output frame rate (house value, VERIFY). */
export const REEL_FPS = 30;
/** Vertical full-screen size of a reel (spec 9.4), the same for every network. */
export const REEL_ANCHO = 1080;
export const REEL_ALTO = 1920;

/** What the render step learns about a source clip by probing it. `ancho`/`alto` are the DISPLAYED size (rotation applied). */
export interface ReelSourceMeta {
  ancho: number;
  alto: number;
  duracionMs: number;
  /** Informational: the frame rate of the source (the output is always constant REEL_FPS). */
  fps: number;
  /** HLG or PQ: needs tone mapping to SDR. */
  hdr: boolean;
}

/** The part of a brief the timeline reads. A GuionView fits structurally. */
export interface ReelGuionInput {
  contenido: {
    escenas: readonly { orden: number; texto_en_pantalla: string; duracion_s?: number | undefined }[];
  };
  tomas: readonly {
    orden: number;
    fuente: 'media_real' | 'faltante';
    media_id: string | null;
    entrada_ms: number | null;
    salida_ms: number | null;
  }[];
}

export interface ReelSegment {
  /** Scene number, 1 to n. */
  escena: number;
  mediaId: string;
  /** Where in the source the scene starts, in ms. */
  inicioMs: number;
  /** Exact number of output frames of the scene. */
  frames: number;
  /** frames / REEL_FPS, in ms. */
  duracionMs: number;
  /** Region of the DISPLAYED source to keep (even numbers, inside the source). */
  recorte: { left: number; top: number; width: number; height: number };
  /** Target pixels per source pixel. */
  escala: number;
  hdr: boolean;
  fpsFuente: number;
  /** True when the scene has on-screen text, so the caller must supply its overlay PNG. */
  overlay: boolean;
}

export interface ReelTimeline {
  fps: typeof REEL_FPS;
  ancho: number;
  alto: number;
  totalFrames: number;
  totalMs: number;
  segmentos: readonly ReelSegment[];
}

const framesToMs = (frames: number): number => Math.round((frames * 1000) / REEL_FPS);
const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

function validMeta(meta: ReelSourceMeta | undefined): meta is ReelSourceMeta {
  return (
    meta !== undefined &&
    isPositiveInt(meta.ancho) &&
    isPositiveInt(meta.alto) &&
    typeof meta.duracionMs === 'number' &&
    Number.isFinite(meta.duracionMs) &&
    meta.duracionMs > 0 &&
    typeof meta.fps === 'number' &&
    Number.isFinite(meta.fps) &&
    meta.fps > 0 &&
    typeof meta.hdr === 'boolean'
  );
}

/** Crop sizes and offsets rounded down to even numbers: the chroma of yuv420p has half the resolution. */
function even(crop: { left: number; top: number; width: number; height: number }): ReelSegment['recorte'] {
  const floorEven = (n: number) => n - (n % 2);
  return {
    left: floorEven(crop.left),
    top: floorEven(crop.top),
    width: Math.max(2, floorEven(crop.width)),
    height: Math.max(2, floorEven(crop.height)),
  };
}

/**
 * Builds the segments of a reel. Refusals are typed, each listing ALL the scenes it affects (numbers
 * and ids only), in this order: invalid structure, scenes without video, bad marks, scene longer than
 * its source stretch, source too small, total duration out of range.
 *
 * `mediaMeta` is keyed by media id. A scene without marks uses its clip from the start; with marks it
 * starts at the in mark and takes `duracion_s` of the marked stretch.
 */
export function buildReelTimeline(guion: ReelGuionInput, mediaMeta: Readonly<Record<string, ReelSourceMeta>>): ReelTimeline {
  const limites = LIMITES_FORMATO.reel;
  const escenas = guion.contenido.escenas;
  const n = escenas.length;

  // 1. Structure.
  if (n < limites.escenasMin || n > limites.escenasMax) throw new TimelineInvalidoError('numero_de_escenas');
  if (escenas.some((e, i) => e.orden !== i + 1)) throw new TimelineInvalidoError('escenas_sin_orden');
  const tomas = [...guion.tomas].sort((a, b) => a.orden - b.orden);
  if (tomas.length !== n || tomas.some((t, i) => t.orden !== i + 1)) throw new TimelineInvalidoError('tomas_distintas_de_escenas');
  const frames = escenas.map((e) => (typeof e.duracion_s === 'number' && Number.isFinite(e.duracion_s) && e.duracion_s > 0 ? Math.round(e.duracion_s * REEL_FPS) : 0));
  if (frames.some((f) => f < 1)) throw new TimelineInvalidoError('duracion_de_escena_invalida');

  // 2. A video for every scene.
  const sinVideo: number[] = [];
  const metaDe = (i: number): ReelSourceMeta | undefined => {
    const toma = tomas[i]!;
    return toma.fuente === 'media_real' && toma.media_id !== null ? mediaMeta[toma.media_id] : undefined;
  };
  for (let i = 0; i < n; i++) if (metaDe(i) === undefined) sinVideo.push(i + 1);
  if (sinVideo.length > 0) throw new EscenaSinVideoError(sinVideo);
  if (escenas.some((_e, i) => !validMeta(metaDe(i)))) throw new TimelineInvalidoError('metadatos_invalidos');

  // 3. Marks inside the clip.
  const tramo: { inicio: number; fin: number }[] = [];
  const marcasMalas: number[] = [];
  for (let i = 0; i < n; i++) {
    const { entrada_ms: entrada, salida_ms: salida } = tomas[i]!;
    const duracion = metaDe(i)!.duracionMs;
    if (entrada === null && salida === null) {
      tramo.push({ inicio: 0, fin: duracion });
    } else if (entrada === null || salida === null || !Number.isInteger(entrada) || !Number.isInteger(salida) || entrada < 0 || salida <= entrada || salida > duracion) {
      marcasMalas.push(i + 1);
      tramo.push({ inicio: 0, fin: 0 });
    } else {
      tramo.push({ inicio: entrada, fin: salida });
    }
  }
  if (marcasMalas.length > 0) throw new MarcasFueraDeRangoError(marcasMalas);

  // 4. The scene must fit in its stretch.
  const largas: number[] = [];
  for (let i = 0; i < n; i++) if (framesToMs(frames[i]!) > tramo[i]!.fin - tramo[i]!.inicio) largas.push(i + 1);
  if (largas.length > 0) throw new EscenaMasLargaQueLaFuenteError(largas);

  // 5. Cover-fit into 1080x1920 without enlarging more than MAX_UPSCALE.
  const recortes: ReturnType<typeof computeCoverCrop>[] = [];
  const pequenasIds = new Set<string>();
  const pequenasEscenas: number[] = [];
  let primera: SourceTooSmallError | undefined;
  for (let i = 0; i < n; i++) {
    const meta = metaDe(i)!;
    try {
      recortes.push(computeCoverCrop({ ancho: meta.ancho, alto: meta.alto }, { ancho: REEL_ANCHO, alto: REEL_ALTO }));
    } catch (error) {
      if (!(error instanceof SourceTooSmallError)) throw error;
      primera ??= error;
      pequenasIds.add(tomas[i]!.media_id!);
      pequenasEscenas.push(i + 1);
    }
  }
  if (primera) throw new FuentesMuyPequenasError(primera, [...pequenasIds], pequenasEscenas);

  // 6. Total length, in whole frames.
  const totalFrames = frames.reduce((a, b) => a + b, 0);
  const { min, max } = limites.duracionTotalS!;
  if (totalFrames < min * REEL_FPS || totalFrames > max * REEL_FPS) {
    throw new DuracionTotalFueraDeRangoError(framesToMs(totalFrames), min * 1000, max * 1000);
  }

  const segmentos: ReelSegment[] = escenas.map((escena, i) => {
    const meta = metaDe(i)!;
    return {
      escena: i + 1,
      mediaId: tomas[i]!.media_id!,
      inicioMs: tramo[i]!.inicio,
      frames: frames[i]!,
      duracionMs: framesToMs(frames[i]!),
      recorte: even(recortes[i]!),
      escala: recortes[i]!.scale,
      hdr: meta.hdr,
      fpsFuente: meta.fps,
      overlay: escena.texto_en_pantalla.trim() !== '',
    };
  });
  return { fps: REEL_FPS, ancho: REEL_ANCHO, alto: REEL_ALTO, totalFrames, totalMs: framesToMs(totalFrames), segmentos };
}
