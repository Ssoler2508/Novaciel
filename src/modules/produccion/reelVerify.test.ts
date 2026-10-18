import { describe, expect, it } from 'vitest';
import type { Mp4Layout } from '../../lib/media/ffmpeg/mp4Boxes.js';
import type { VideoFacts } from '../../lib/media/ffmpeg/parseVideoFacts.js';
import { SalidaInvalidaError, type SalidaInvalidaRazon } from './errors.js';
import type { ReelTimeline } from './reelTimeline.js';
import { ETIQUETAS_FORMATO_PERMITIDAS, MAX_REEL_BYTES, TOLERANCIA_DURACION_MS, verifyReelOutput } from './reelVerify.js';

const TIMELINE: ReelTimeline = { fps: 30, ancho: 1080, alto: 1920, totalFrames: 450, totalMs: 15_000, segmentos: [] };

/** VideoFacts with a list the tests may change. */
type MutableFacts = Omit<VideoFacts, 'streams'> & { streams: { tipo: string; tags: Record<string, string> }[] };

const good = (): { facts: MutableFacts; layout: Mp4Layout; timeline: ReelTimeline; tamanoBytes: number } => ({
  facts: {
    formato: 'mov,mp4,m4a,3gp,3g2,mj2',
    duracionMs: 15_000,
    tamanoBytes: 9_000_000,
    video: {
      ancho: 1080,
      alto: 1920,
      codec: 'h264',
      perfil: 'High',
      pixFmt: 'yuv420p',
      rFrameRate: '30/1',
      avgFrameRate: '30/1',
      fps: 30,
      nbFrames: 450,
      duracionMs: 15_000,
      hdr: false,
      colorSpace: 'bt709',
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorRange: 'tv',
    },
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2, duracionMs: 15_010 },
    streams: [
      { tipo: 'video', tags: { language: 'und', handler_name: 'VideoHandler' } },
      { tipo: 'audio', tags: { language: 'und', handler_name: 'SoundHandler' } },
    ],
    tagsFormato: { ...ETIQUETAS_FORMATO_PERMITIDAS },
  },
  layout: {
    superiores: ['ftyp', 'moov', 'free', 'mdat'],
    dentroDeMoov: [
      { ruta: 'mvhd', tamano: 108 },
      { ruta: 'trak', tamano: 900 },
      { ruta: 'trak/tkhd', tamano: 92 },
      { ruta: 'trak/mdia', tamano: 768 },
      { ruta: 'trak/mdia/minf', tamano: 683 },
      { ruta: 'udta', tamano: 61 },
      { ruta: 'udta/meta', tamano: 53 },
      { ruta: 'udta/meta/hdlr', tamano: 33 },
      { ruta: 'udta/meta/ilst', tamano: 8 },
    ],
    moovDemasiadoGrande: false,
  },
  timeline: TIMELINE,
  tamanoBytes: 9_000_000,
});

type Input = ReturnType<typeof good>;
function refusal(change: (input: Input) => void): SalidaInvalidaError {
  const input = good();
  change(input);
  try {
    verifyReelOutput(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SalidaInvalidaError);
    return error as SalidaInvalidaError;
  }
  throw new Error('expected the output to be refused');
}
const video = (input: Input) => input.facts.video!;

describe('verifyReelOutput: what a good reel looks like', () => {
  it('accepts the shape FFmpeg really writes (including its empty udta/meta)', () => {
    expect(() => verifyReelOutput(good())).not.toThrow();
  });

  it('allows the duration to differ by up to the stated tolerance, and no more', () => {
    for (const delta of [-TOLERANCIA_DURACION_MS, 0, TOLERANCIA_DURACION_MS]) {
      const input = good();
      input.facts.duracionMs = 15_000 + delta;
      expect(() => verifyReelOutput(input), String(delta)).not.toThrow();
    }
    expect(refusal((i) => (i.facts.duracionMs = 15_000 + TOLERANCIA_DURACION_MS + 1)).razon).toBe('duracion');
    expect(refusal((i) => (i.facts.duracionMs = 14_899)).razon).toBe('duracion');
    expect(refusal((i) => (i.facts.duracionMs = null)).razon).toBe('duracion');
  });
});

describe('verifyReelOutput: the format', () => {
  const cases: [string, (i: Input) => void, SalidaInvalidaRazon][] = [
    ['not an MP4', (i) => (i.facts.formato = 'matroska,webm'), 'formato_contenedor'],
    ['no video stream', (i) => (i.facts.video = null), 'codec_video'],
    ['wrong width', (i) => (video(i).ancho = 1920), 'tamano'],
    ['wrong height', (i) => (video(i).alto = 1080), 'tamano'],
    ['hevc', (i) => (video(i).codec = 'hevc'), 'codec_video'],
    ['main profile', (i) => (video(i).perfil = 'Main'), 'perfil'],
    ['10-bit', (i) => (video(i).pixFmt = 'yuv420p10le'), 'pix_fmt'],
    ['yuv444', (i) => (video(i).pixFmt = 'yuv444p'), 'pix_fmt'],
    ['25 fps', (i) => ((video(i).rFrameRate = '25/1'), (video(i).avgFrameRate = '25/1')), 'fps'],
    ['29.97 fps', (i) => ((video(i).rFrameRate = '30000/1001'), (video(i).avgFrameRate = '30000/1001')), 'fps'],
    ['variable rate (average differs)', (i) => (video(i).avgFrameRate = '2997/100'), 'fps'],
    ['one frame short', (i) => (video(i).nbFrames = 449), 'fotogramas'],
    ['frame count unknown', (i) => (video(i).nbFrames = null), 'fotogramas'],
    ['wrong container duration', (i) => (i.facts.duracionMs = 20_000), 'duracion'],
    ['colour space', (i) => (video(i).colorSpace = 'bt2020nc'), 'color'],
    ['colour transfer is PQ', (i) => (video(i).colorTransfer = 'smpte2084'), 'color'],
    ['colour primaries missing', (i) => (video(i).colorPrimaries = null), 'color'],
    ['full range', (i) => (video(i).colorRange = 'pc'), 'color'],
    ['no audio', (i) => ((i.facts.audio = null), i.facts.streams.pop()), 'streams_inesperados'],
    ['audio is not aac', (i) => (i.facts.audio!.codec = 'opus'), 'audio'],
    ['audio at 44.1 kHz', (i) => (i.facts.audio!.sampleRate = 44_100), 'audio'],
    ['mono audio', (i) => (i.facts.audio!.channels = 1), 'audio'],
    ['audio much longer than the video', (i) => (i.facts.audio!.duracionMs = 16_000), 'audio'],
    ['an extra data stream', (i) => i.facts.streams.push({ tipo: 'data', tags: {} }), 'streams_inesperados'],
    ['audio before video', (i) => i.facts.streams.reverse(), 'streams_inesperados'],
    ['too big', (i) => (i.tamanoBytes = MAX_REEL_BYTES + 1), 'tamano_maximo'],
    ['empty file', (i) => (i.tamanoBytes = 0), 'tamano_maximo'],
    ['no faststart: mdat before moov', (i) => (i.layout.superiores = ['ftyp', 'mdat', 'moov']), 'faststart'],
    ['no moov', (i) => (i.layout.superiores = ['ftyp', 'mdat']), 'faststart'],
    ['no mdat', (i) => (i.layout.superiores = ['ftyp', 'moov']), 'faststart'],
    ['moov too big to read', (i) => (i.layout.moovDemasiadoGrande = true), 'moov_demasiado_grande'],
  ];
  it.each(cases)('%s', (_name, change, razon) => {
    expect(refusal(change).razon).toBe(razon);
  });
});

describe('verifyReelOutput: no metadata (exact allow-lists)', () => {
  it('accepts exactly the three ftyp brand fields at format level, with exactly their values', () => {
    expect(ETIQUETAS_FORMATO_PERMITIDAS).toEqual({ major_brand: 'isom', minor_version: '512', compatible_brands: 'isomiso2avc1mp41' });
    expect(() => verifyReelOutput({ ...good(), facts: { ...good().facts, tagsFormato: {} } })).not.toThrow();
    for (const [key, value] of [['major_brand', 'qt  '], ['minor_version', '0'], ['compatible_brands', 'mp42']] as const) {
      const error = refusal((i) => (i.facts.tagsFormato = { ...i.facts.tagsFormato, [key]: value }));
      expect([error.razon, error.detalle]).toEqual(['etiqueta_no_permitida', key]);
    }
  });

  it.each(['encoder', 'creation_time', 'title', 'comment', 'location', 'location-eng', 'artist', 'com.apple.quicktime.make', 'description', 'copyright'])(
    'refuses the format tag %s, naming the key and never the value',
    (key) => {
      const error = refusal((i) => (i.facts.tagsFormato = { ...i.facts.tagsFormato, [key]: 'Lavf61.1.100 secreto 40.7128' }));
      expect([error.razon, error.detalle]).toEqual(['etiqueta_no_permitida', key]);
      expect(error.message).not.toContain('secreto');
      expect(error.message).not.toContain('40.7128');
    },
  );

  it('accepts only language=und and the exact handler names on the streams', () => {
    // The right names are only right on their own stream.
    expect(refusal((i) => (i.facts.streams[0]!.tags = { language: 'und', handler_name: 'SoundHandler' })).detalle).toBe('handler_name');
    expect(refusal((i) => (i.facts.streams[1]!.tags = { language: 'und', handler_name: 'VideoHandler' })).detalle).toBe('handler_name');
    for (const value of ['videohandler', 'VideoHandler ', 'Core Media Video', '']) {
      expect(refusal((i) => (i.facts.streams[0]!.tags = { ...i.facts.streams[0]!.tags, handler_name: value })).detalle, value).toBe('handler_name');
    }
    expect(refusal((i) => (i.facts.streams[0]!.tags = { language: 'spa', handler_name: 'VideoHandler' })).detalle).toBe('language');
    for (const key of ['encoder', 'creation_time', 'vendor_id', 'rotate', 'timecode']) {
      const error = refusal((i) => (i.facts.streams[1]!.tags = { ...i.facts.streams[1]!.tags, [key]: 'x' }));
      expect([error.razon, error.detalle]).toEqual(['etiqueta_no_permitida', key]);
    }
  });

  it('accepts a stream with no tags at all (fewer than the allow-list is fine)', () => {
    const input = good();
    input.facts.streams = [{ tipo: 'video', tags: {} }, { tipo: 'audio', tags: {} }];
    expect(() => verifyReelOutput(input)).not.toThrow();
  });

  it.each([
    ['uuid', { superiores: ['ftyp', 'uuid', 'moov', 'mdat'] }],
    ['meta at the top level', { superiores: ['ftyp', 'meta', 'moov', 'mdat'] }],
    ['udta at the top level', { superiores: ['ftyp', 'moov', 'udta', 'mdat'] }],
    ['XMP_', { superiores: ['ftyp', 'moov', 'XMP_', 'mdat'] }],
  ])('refuses an unexpected top-level box: %s', (_name, layout) => {
    expect(refusal((i) => Object.assign(i.layout, layout)).razon).toBe('atomo_no_permitido');
  });

  const extra = (...boxes: { ruta: string; tamano: number }[]) => (i: Input) => i.layout.dentroDeMoov.push(...boxes);
  it('refuses a location or metadata box anywhere in moov', () => {
    for (const [name, change, tipo] of [
      ['GPS box', extra({ ruta: 'udta/©xyz', tamano: 30 }), '©xyz'],
      ['3GPP location', extra({ ruta: 'udta/loci', tamano: 35 }), 'loci'],
      ['uuid in moov', extra({ ruta: 'uuid', tamano: 40 }), 'uuid'],
      ['XMP in moov', extra({ ruta: 'XMP_', tamano: 40 }), 'XMP_'],
      ['udta in a track', extra({ ruta: 'trak/udta', tamano: 40 }), 'udta'],
      ['meta in a track', extra({ ruta: 'trak/meta', tamano: 40 }), 'meta'],
      ['keys', extra({ ruta: 'meta/keys', tamano: 40 }), 'keys'],
    ] as const) {
      const error = refusal(change);
      expect([name, error.razon, error.detalle]).toEqual([name, 'atomo_no_permitido', tipo]);
    }
  });

  it('accepts the empty udta/meta FFmpeg always writes, but not one with entries in it', () => {
    // A tag entry makes ilst bigger than its 8-byte header.
    expect(refusal((i) => (i.layout.dentroDeMoov.find((b) => b.ruta === 'udta/meta/ilst')!.tamano = 36)).detalle).toBe('ilst');
    // Anything else inside the udta.
    expect(refusal(extra({ ruta: 'udta/name', tamano: 20 })).detalle).toBe('name');
    expect(refusal(extra({ ruta: 'udta/meta/xml ', tamano: 20 })).detalle).toBe('xml ');
    expect(refusal(extra({ ruta: 'udta/meta/keys', tamano: 20 })).detalle).toBe('keys');
  });
});
