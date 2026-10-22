import path from 'node:path';
import { HdrNoSoportadoError, RutaInvalidaError } from './errors.js';
import { REEL_FPS, type ReelTimeline } from './reelTimeline.js';

// The FFmpeg arguments of a reel (Step 7b): one pass that cuts, crops, scales, normalizes the frame
// rate, overlays the text PNGs, joins the scenes, adds a silent AAC track and encodes. PURE: it
// returns an argument ARRAY for `spawn` (never a shell line). The only strings in it that are not
// fixed words or numbers are the paths passed in, each written as `file:<absolute path>` so FFmpeg can
// never read one as an option or as a protocol ("concat:", "http:"). The builder receives the
// timeline, which has no client text, so no copy can reach an argument.

export interface ReelOutputSpec {
  /** x264 quality and speed (house values, VERIFY). */
  crf: number;
  preset: 'ultrafast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow';
  /** Peak bit rate and buffer, for example "12M" (house values, VERIFY). */
  maxrate: string;
  bufsize: string;
  /** Frames between key frames. */
  gop: number;
  /** Audio of the reel: a silent AAC track (decision of checkpoint A). Source audio is not built. */
  audio: 'silent';
  /** True when this FFmpeg has zscale and tonemap, so HDR sources can be tone-mapped to SDR. */
  hdrToneMap: boolean;
}

export const DEFAULT_REEL_OUTPUT: ReelOutputSpec = {
  crf: 20,
  preset: 'medium',
  maxrate: '12M',
  bufsize: '24M',
  gop: 60,
  audio: 'silent',
  hdrToneMap: true,
};

/** A scene's text overlay: one transparent PNG held for the whole scene (7b), or a PNG sequence with one file per frame (7c). */
export type ReelOverlayInput = string | { carpeta: string; patron: string };

export interface ReelPaths {
  /** Absolute path of the downloaded source clip, by media id. */
  fuentes: Readonly<Record<string, string>>;
  /**
   * The transparent overlay (1080x1920), by scene number. Exactly the scenes with `overlay`. A string is the
   * absolute path of a PNG; `{ carpeta, patron }` is a PNG sequence (`capa-%05d.png`) of exactly the scene's frames.
   */
  overlays: Readonly<Record<number, ReelOverlayInput>>;
  /** Absolute path of the MP4 to write. */
  salida: string;
}

/** Extra source read after the end of a scene, so the frame-rate filter never runs dry. */
const MARGEN_MS = 200;
const AUDIO_HZ = 48_000;

/** HLG/PQ BT.2020 to SDR BT.709 (verified on this machine's FFmpeg with PQ and HLG sources). */
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

/** Integer milliseconds as FFmpeg seconds, without floating point: 1500 -> "1.500". */
function seconds(ms: number): string {
  const whole = Math.max(0, Math.round(ms));
  return `${Math.floor(whole / 1000)}.${String(whole % 1000).padStart(3, '0')}`;
}

function filePath(value: string | undefined, missing: 'fuente_faltante' | 'overlay_faltante' | 'salida_faltante'): string {
  if (value === undefined || value === '') throw new RutaInvalidaError(missing);
  if (/[\u0000-\u001f]/.test(value)) throw new RutaInvalidaError('ruta_con_caracter_de_control');
  if (!path.isAbsolute(value)) throw new RutaInvalidaError('ruta_no_absoluta');
  return `file:${value}`;
}

/** `file:<folder>/<pattern>` for a PNG sequence. The pattern is a fixed shape and the folder may hold no `%`. */
function sequencePath(value: { carpeta: string; patron: string }): string {
  if (value.patron !== 'capa-%05d.png') throw new RutaInvalidaError('overlay_faltante');
  if (value.carpeta.includes('%')) throw new RutaInvalidaError('ruta_con_patron');
  return `${filePath(value.carpeta, 'overlay_faltante')}${value.carpeta.endsWith(path.sep) || value.carpeta.endsWith('/') ? '' : '/'}${value.patron}`;
}

function checkSpec(spec: ReelOutputSpec): void {
  const rate = /^[1-9][0-9]{0,3}[kM]$/;
  if (!Number.isInteger(spec.crf) || spec.crf < 0 || spec.crf > 51 || !Number.isInteger(spec.gop) || spec.gop < 1 || !rate.test(spec.maxrate) || !rate.test(spec.bufsize)) {
    throw new TypeError('Invalid reel output spec');
  }
}

/**
 * The argument array for `ffmpeg`. Throws HdrNoSoportadoError when a segment is HDR and the spec says
 * this FFmpeg cannot tone-map, and RutaInvalidaError for a missing, extra, relative or control-character
 * path (the path itself is never echoed).
 */
export function buildFfmpegArgs(timeline: ReelTimeline, paths: ReelPaths, spec: ReelOutputSpec = DEFAULT_REEL_OUTPUT): string[] {
  checkSpec(spec);
  const hdr = timeline.segmentos.filter((s) => s.hdr).map((s) => s.escena);
  if (hdr.length > 0 && !spec.hdrToneMap) throw new HdrNoSoportadoError(hdr);

  // Paths first, so a bad one is reported before anything is built.
  const conOverlay = new Set(timeline.segmentos.filter((s) => s.overlay).map((s) => s.escena));
  for (const key of Object.keys(paths.overlays)) if (!conOverlay.has(Number(key))) throw new RutaInvalidaError('overlay_sobrante');
  const fuentes = new Map<number, string>();
  const overlays = new Map<number, { ruta: string; secuencia: boolean }>();
  for (const segmento of timeline.segmentos) {
    fuentes.set(segmento.escena, filePath(paths.fuentes[segmento.mediaId], 'fuente_faltante'));
    if (segmento.overlay) {
      const capa = paths.overlays[segmento.escena];
      if (capa === undefined) throw new RutaInvalidaError('overlay_faltante');
      overlays.set(segmento.escena, typeof capa === 'string' ? { ruta: filePath(capa, 'overlay_faltante'), secuencia: false } : { ruta: sequencePath(capa), secuencia: true });
    }
  }
  const salida = filePath(paths.salida, 'salida_faltante');

  const inputs: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  let inputCount = 0;

  for (const segmento of timeline.segmentos) {
    const fuente = inputCount++;
    inputs.push('-ss', seconds(segmento.inicioMs), '-t', seconds(segmento.duracionMs + MARGEN_MS), '-i', fuentes.get(segmento.escena)!);
    const { left, top, width, height } = segmento.recorte;
    const chain = [
      'setpts=PTS-STARTPTS',
      `fps=${REEL_FPS}`,
      `trim=end_frame=${segmento.frames}`,
      'setpts=PTS-STARTPTS',
      ...(segmento.hdr ? [TONEMAP] : []),
      `crop=${width}:${height}:${left}:${top}`,
      `scale=${timeline.ancho}:${timeline.alto}:flags=lanczos:out_color_matrix=bt709:out_range=tv`,
      'setsar=1',
      'format=yuv420p',
    ].join(',');
    const overlay = overlays.get(segmento.escena);
    if (overlay === undefined) {
      filters.push(`[${fuente}:v]${chain}[v${segmento.escena}]`);
    } else {
      const capa = inputCount++;
      if (overlay.secuencia) inputs.push('-framerate', String(REEL_FPS), '-start_number', '0', '-f', 'image2', '-i', overlay.ruta);
      else inputs.push('-loop', '1', '-framerate', String(REEL_FPS), '-t', seconds(segmento.duracionMs + MARGEN_MS), '-i', overlay.ruta);
      filters.push(`[${fuente}:v]${chain}[b${segmento.escena}]`);
      filters.push(`[${capa}:v]format=rgba[o${segmento.escena}]`);
      filters.push(`[b${segmento.escena}][o${segmento.escena}]overlay=0:0:format=auto:shortest=1[v${segmento.escena}]`);
    }
    labels.push(`[v${segmento.escena}]`);
  }
  filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[vout]`);

  const audio = inputCount++;
  inputs.push('-f', 'lavfi', '-t', seconds(timeline.totalMs), '-i', `anullsrc=r=${AUDIO_HZ}:cl=stereo`);

  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    `${audio}:a`,
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level:v',
    '4.1',
    '-crf',
    String(spec.crf),
    '-preset',
    spec.preset,
    '-maxrate',
    spec.maxrate,
    '-bufsize',
    spec.bufsize,
    '-g',
    String(spec.gop),
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    // Two bitstream filters on the video: remove every SEI message (x264 writes its version and
    // settings into one), then write the VUI colour tags (BT.709, limited range), which FFmpeg's own
    // -color_* options do not get into x264's header.
    '-bsf:v',
    'filter_units=remove_types=6,h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0',
    '-r',
    String(REEL_FPS),
    '-fps_mode',
    'cfr',
    '-frames:v',
    String(timeline.totalFrames),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    String(AUDIO_HZ),
    '-ac',
    '2',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    // Without this the video stream carries an "encoder" tag (the x264 version and settings).
    '-metadata:s:v:0',
    'encoder=',
    '-movflags',
    '+faststart',
    salida,
  ];
}
