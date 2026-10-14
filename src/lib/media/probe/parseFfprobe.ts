import { z } from 'zod';
import { MediaProbeError, type ProbeResult } from './types.js';

// Parses `ffprobe -print_format json -show_format -show_streams`. Only the fields below are read;
// everything else in the output is ignored.

const streamSchema = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  duration: z.string().optional(),
  tags: z.object({ rotate: z.string().optional() }).passthrough().optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() }).passthrough()).optional(),
});

const outputSchema = z.object({
  streams: z.array(streamSchema).default([]),
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
      tags: z.object({ major_brand: z.string().optional() }).passthrough().optional(),
    })
    .default({}),
});

const IMAGE_FORMATS = /^(image2|.*_pipe)$/;
const IMAGE_MIME: Record<string, string> = { mjpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const VIDEO_FORMAT = /(^|,)mp4(,|$)/;

/** Rotation in degrees from the display matrix or the legacy `rotate` tag, normalized to 0..359. */
function rotationOf(stream: z.infer<typeof streamSchema>): number {
  const fromSideData = stream.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const value = fromSideData ?? (stream.tags?.rotate !== undefined ? Number(stream.tags.rotate) : 0);
  if (!Number.isFinite(value)) return 0;
  return ((Math.round(value) % 360) + 360) % 360;
}

function durationMsOf(...candidates: (string | undefined)[]): number | null {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const seconds = Number(candidate);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  return null;
}

/** Turns ffprobe's JSON into a ProbeResult, or throws MediaProbeError('parse'). */
export function parseFfprobeOutput(output: string): ProbeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new MediaProbeError('parse');
  }
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) throw new MediaProbeError('parse');
  const { streams, format } = parsed.data;
  const formatName = format.format_name ?? '';
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video || !video.width || !video.height || video.width <= 0 || video.height <= 0) throw new MediaProbeError('parse');

  if (IMAGE_FORMATS.test(formatName)) {
    const mime = IMAGE_MIME[video.codec_name ?? ''];
    if (!mime) throw new MediaProbeError('parse');
    return { kind: 'foto', format: formatName, mime, width: video.width, height: video.height, durationMs: null };
  }

  if (VIDEO_FORMAT.test(formatName)) {
    const durationMs = durationMsOf(video.duration, format.duration);
    if (durationMs === null) throw new MediaProbeError('parse');
    const turned = rotationOf(video) % 180 === 90;
    return {
      kind: 'video',
      format: formatName,
      // "qt  " is the QuickTime brand; every other brand of this container family is MP4.
      mime: format.tags?.major_brand?.trim() === 'qt' ? 'video/quicktime' : 'video/mp4',
      width: turned ? video.height : video.width,
      height: turned ? video.width : video.height,
      durationMs,
    };
  }
  throw new MediaProbeError('parse');
}
