import { z } from 'zod';
import { MediaProbeError } from '../probe/types.js';

// Parses `ffprobe -print_format json -show_format -show_streams` for a VIDEO file into the facts that
// reel production and the output verifier need (Step 7b). The upload probe (probe/parseFfprobe.ts)
// is a smaller read for a different job and is left as it is.

const tagsSchema = z.record(z.string(), z.unknown()).optional();

const streamSchema = z
  .object({
    index: z.number().int().optional(),
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    profile: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    pix_fmt: z.string().optional(),
    r_frame_rate: z.string().optional(),
    avg_frame_rate: z.string().optional(),
    nb_frames: z.string().optional(),
    duration: z.string().optional(),
    color_space: z.string().optional(),
    color_transfer: z.string().optional(),
    color_primaries: z.string().optional(),
    color_range: z.string().optional(),
    sample_rate: z.string().optional(),
    channels: z.number().int().optional(),
    tags: tagsSchema,
    side_data_list: z.array(z.object({ rotation: z.number().optional() }).passthrough()).optional(),
  })
  .passthrough();

const outputSchema = z.object({
  streams: z.array(streamSchema).default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      size: z.string().optional(),
      tags: tagsSchema,
    })
    .passthrough()
    .default({}),
});

export interface VideoStreamFacts {
  /** Displayed size: already swapped when the stream is rotated by 90 or 270 degrees. */
  ancho: number;
  alto: number;
  codec: string;
  perfil: string | null;
  pixFmt: string | null;
  /** The frame rates exactly as ffprobe prints them, for example "30/1". */
  rFrameRate: string | null;
  avgFrameRate: string | null;
  /** Average frame rate as a number, or null when it is unknown. */
  fps: number | null;
  nbFrames: number | null;
  duracionMs: number | null;
  /** HLG or PQ transfer: needs tone mapping to SDR. */
  hdr: boolean;
  colorSpace: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorRange: string | null;
}

export interface AudioStreamFacts {
  codec: string;
  sampleRate: number | null;
  channels: number | null;
  duracionMs: number | null;
}

export interface VideoFacts {
  formato: string;
  duracionMs: number | null;
  tamanoBytes: number | null;
  /** The first video stream; null when the file has none. */
  video: VideoStreamFacts | null;
  /** The first audio stream, or null. */
  audio: AudioStreamFacts | null;
  /** Every stream with its type and tags (values as strings), in file order. */
  streams: readonly { tipo: string; tags: Readonly<Record<string, string>> }[];
  tagsFormato: Readonly<Record<string, string>>;
}

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

function toTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) result[key] = typeof value === 'string' ? value : JSON.stringify(value);
  return result;
}

function secondsToMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function wholeNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** "30000/1001" -> 29.97; "0/0" and anything unreadable -> null. */
export function parseFrameRate(value: string | undefined): number | null {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const denominator = Number(match[2]);
  const rate = denominator === 0 ? 0 : Number(match[1]) / denominator;
  return rate > 0 && Number.isFinite(rate) ? rate : null;
}

function rotationOf(stream: z.infer<typeof streamSchema>): number {
  const fromSideData = stream.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const legacy = stream.tags?.rotate;
  const value = fromSideData ?? (typeof legacy === 'string' ? Number(legacy) : 0);
  if (!Number.isFinite(value)) return 0;
  return ((Math.round(value) % 360) + 360) % 360;
}

/** Turns ffprobe's JSON into VideoFacts, or throws MediaProbeError('parse'). */
export function parseVideoFacts(output: string): VideoFacts {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new MediaProbeError('parse');
  }
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) throw new MediaProbeError('parse');
  const { streams, format } = parsed.data;

  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');

  let video: VideoStreamFacts | null = null;
  if (v) {
    if (!v.width || !v.height || v.width <= 0 || v.height <= 0 || !v.codec_name) throw new MediaProbeError('parse');
    const turned = rotationOf(v) % 180 === 90;
    video = {
      ancho: turned ? v.height : v.width,
      alto: turned ? v.width : v.height,
      codec: v.codec_name,
      perfil: v.profile ?? null,
      pixFmt: v.pix_fmt ?? null,
      rFrameRate: v.r_frame_rate ?? null,
      avgFrameRate: v.avg_frame_rate ?? null,
      fps: parseFrameRate(v.avg_frame_rate) ?? parseFrameRate(v.r_frame_rate),
      nbFrames: wholeNumber(v.nb_frames),
      duracionMs: secondsToMs(v.duration),
      hdr: HDR_TRANSFERS.has(v.color_transfer ?? ''),
      colorSpace: v.color_space ?? null,
      colorPrimaries: v.color_primaries ?? null,
      colorTransfer: v.color_transfer ?? null,
      colorRange: v.color_range ?? null,
    };
  }

  const audio: AudioStreamFacts | null = a?.codec_name
    ? { codec: a.codec_name, sampleRate: wholeNumber(a.sample_rate), channels: a.channels ?? null, duracionMs: secondsToMs(a.duration) }
    : null;

  return {
    formato: format.format_name ?? '',
    duracionMs: secondsToMs(format.duration),
    tamanoBytes: wholeNumber(format.size),
    video,
    audio,
    streams: streams.map((s) => ({ tipo: s.codec_type ?? 'desconocido', tags: toTags(s.tags) })),
    tagsFormato: toTags(format.tags),
  };
}
