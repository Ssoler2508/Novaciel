import type { Mp4Layout } from '../../lib/media/ffmpeg/mp4Boxes.js';
import type { VideoFacts } from '../../lib/media/ffmpeg/parseVideoFacts.js';
import { SalidaInvalidaError } from './errors.js';
import { REEL_ALTO, REEL_ANCHO, REEL_FPS, type ReelTimeline } from './reelTimeline.js';

// The check of the MP4 FFmpeg wrote, before anyone stores it. Pure over the probed facts and the box
// layout. The first thing wrong throws SalidaInvalidaError (reason, plus a tag key or a box type;
// never a value). A reel is only stored if it passes.

/** Largest reel file (house value, VERIFICAR against each network). */
export const MAX_REEL_BYTES = 100 * 1024 * 1024;
/** Container and audio durations may differ from the plan by one frame plus the AAC priming. */
export const TOLERANCIA_DURACION_MS = 100;

/**
 * FORMAT tags a reel may have: exactly the three fields of the `ftyp` box, which ffprobe lists as
 * format tags on every MP4. They are the file type, not metadata, and with bit-exact output they are
 * always these values. Anything else, or any other value, fails.
 */
export const ETIQUETAS_FORMATO_PERMITIDAS: Readonly<Record<string, string>> = {
  major_brand: 'isom',
  minor_version: '512',
  compatible_brands: 'isomiso2avc1mp41',
};
/** STREAM tags a reel may have, by stream type: exactly these keys with exactly these values. */
export const ETIQUETAS_STREAM_PERMITIDAS: Readonly<Record<'video' | 'audio', Readonly<Record<string, string>>>> = {
  video: { language: 'und', handler_name: 'VideoHandler' },
  audio: { language: 'und', handler_name: 'SoundHandler' },
};

/** Top-level boxes a reel may have. Anything else (`uuid`, `meta`, `udta`, XMP...) fails. */
const CAJAS_SUPERIORES_PERMITIDAS = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip']);
/** Boxes that carry metadata or a location; none may appear inside `moov` (©xyz is the GPS box, loci the 3GPP one). */
const CAJAS_DE_METADATOS = new Set(['udta', 'meta', '©xyz', 'loci', 'uuid', 'XMP_', 'keys', 'ilst']);
/**
 * FFmpeg's MP4 muxer always writes one EMPTY metadata container at the end of `moov`: `udta` holding a
 * `meta` with a `hdlr` and an `ilst` that has no entries (8 bytes, just its header). It carries
 * nothing, and no FFmpeg option removes it. That exact shape is accepted; a `udta` with anything else
 * in it (a tag entry, a location, a uuid) is refused.
 */
const MOOV_UDTA_VACIO = new Map<string, number | null>([
  ['udta', null],
  ['udta/meta', null],
  ['udta/meta/hdlr', null],
  ['udta/meta/ilst', 8],
]);

function checkTags(tags: Readonly<Record<string, string>>, allowed: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(tags)) {
    if (allowed[key] !== value) throw new SalidaInvalidaError('etiqueta_no_permitida', key);
  }
}

/**
 * Verifies the probed output against the timeline and the house format. `tamanoBytes` is the size of
 * the file on disk.
 */
export function verifyReelOutput(input: {
  facts: VideoFacts;
  layout: Mp4Layout;
  /** Only the two totals the file must have, so a stored file can be checked without rebuilding the timeline (quality control derives them from the stored duration). */
  timeline: Pick<ReelTimeline, 'totalFrames' | 'totalMs'>;
  tamanoBytes: number;
  /** The largest accepted file; the default is MAX_REEL_BYTES. Quality control can pass a lower cap (tests do). */
  maxBytes?: number;
}): void {
  const { facts, layout, timeline, tamanoBytes } = input;

  if (!/(^|,)mp4(,|$)/.test(facts.formato)) throw new SalidaInvalidaError('formato_contenedor');
  const { video, audio } = facts;
  if (!video) throw new SalidaInvalidaError('codec_video');

  // Exactly one video and one audio stream, in that order.
  if (facts.streams.length !== 2 || facts.streams[0]!.tipo !== 'video' || facts.streams[1]!.tipo !== 'audio') {
    throw new SalidaInvalidaError('streams_inesperados');
  }

  if (video.ancho !== REEL_ANCHO || video.alto !== REEL_ALTO) throw new SalidaInvalidaError('tamano');
  if (video.codec !== 'h264') throw new SalidaInvalidaError('codec_video');
  if (video.perfil !== 'High') throw new SalidaInvalidaError('perfil');
  if (video.pixFmt !== 'yuv420p') throw new SalidaInvalidaError('pix_fmt');
  const rate = `${REEL_FPS}/1`;
  if (video.rFrameRate !== rate || video.avgFrameRate !== rate) throw new SalidaInvalidaError('fps');
  if (video.nbFrames !== timeline.totalFrames) throw new SalidaInvalidaError('fotogramas');
  if (facts.duracionMs === null || Math.abs(facts.duracionMs - timeline.totalMs) > TOLERANCIA_DURACION_MS) throw new SalidaInvalidaError('duracion');
  if (video.colorSpace !== 'bt709' || video.colorPrimaries !== 'bt709' || video.colorTransfer !== 'bt709' || video.colorRange !== 'tv') {
    throw new SalidaInvalidaError('color');
  }

  if (!audio || audio.codec !== 'aac' || audio.sampleRate !== 48_000 || audio.channels !== 2) throw new SalidaInvalidaError('audio');
  if (audio.duracionMs === null || video.duracionMs === null || Math.abs(audio.duracionMs - video.duracionMs) > TOLERANCIA_DURACION_MS) {
    throw new SalidaInvalidaError('audio', 'duracion');
  }

  if (tamanoBytes <= 0 || tamanoBytes > (input.maxBytes ?? MAX_REEL_BYTES)) throw new SalidaInvalidaError('tamano_maximo');

  // Metadata: an exact allow-list of tags, and no box that carries metadata or a location.
  checkTags(facts.tagsFormato, ETIQUETAS_FORMATO_PERMITIDAS);
  checkTags(facts.streams[0]!.tags, ETIQUETAS_STREAM_PERMITIDAS.video);
  checkTags(facts.streams[1]!.tags, ETIQUETAS_STREAM_PERMITIDAS.audio);
  if (layout.moovDemasiadoGrande) throw new SalidaInvalidaError('moov_demasiado_grande');
  for (const tipo of layout.superiores) if (!CAJAS_SUPERIORES_PERMITIDAS.has(tipo)) throw new SalidaInvalidaError('atomo_no_permitido', tipo);
  for (const { ruta, tamano } of layout.dentroDeMoov) {
    const tipo = ruta.slice(ruta.lastIndexOf('/') + 1);
    if (ruta === 'udta' || ruta.startsWith('udta/')) {
      const exactSize = MOOV_UDTA_VACIO.get(ruta);
      if (exactSize === undefined || (exactSize !== null && tamano !== exactSize)) throw new SalidaInvalidaError('atomo_no_permitido', tipo);
    } else if (CAJAS_DE_METADATOS.has(tipo)) {
      throw new SalidaInvalidaError('atomo_no_permitido', tipo);
    }
  }

  // Faststart: the index comes before the media data, so the file plays while it downloads.
  const moov = layout.superiores.indexOf('moov');
  const mdat = layout.superiores.indexOf('mdat');
  if (moov < 0 || mdat < 0 || moov > mdat) throw new SalidaInvalidaError('faststart');
}
