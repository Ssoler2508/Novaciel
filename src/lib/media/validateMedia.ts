import { open } from 'node:fs/promises';
import type { MediaProbe } from './probe/types.js';

// Content-based validation of an uploaded file. The file name and the declared MIME type are never
// looked at: the type comes from the file's first bytes (an allow-list) and is then confirmed by
// the probe. Anything not on the list is rejected: SVG, HTML, PDF, archives, executables, HEIC.

export type DetectedType = 'jpeg' | 'png' | 'webp' | 'mp4' | 'mov';

const TYPES: Record<DetectedType, { kind: 'foto' | 'video'; mime: string; extension: string }> = {
  jpeg: { kind: 'foto', mime: 'image/jpeg', extension: 'jpg' },
  png: { kind: 'foto', mime: 'image/png', extension: 'png' },
  webp: { kind: 'foto', mime: 'image/webp', extension: 'webp' },
  mp4: { kind: 'video', mime: 'video/mp4', extension: 'mp4' },
  mov: { kind: 'video', mime: 'video/quicktime', extension: 'mov' },
};

// ISO base media brands accepted as MP4. HEIC/HEIF brands (heic, heix, mif1, ...) are NOT here.
const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ']);
const QUICKTIME_BRAND = 'qt  ';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_BYTES = 32;

export type UnsupportedMediaReason = 'unsupported_type' | 'content_mismatch';

/** The file is not an accepted photo or video. The message is fixed: no file name, no content. */
export class UnsupportedMediaError extends Error {
  constructor(readonly reason: UnsupportedMediaReason) {
    super(
      reason === 'unsupported_type'
        ? 'The file is not an accepted photo or video type'
        : 'The file content does not match its detected type',
    );
    this.name = 'UnsupportedMediaError';
  }
}

/** Detects the type from the first bytes, or null when it is not on the allow-list. */
export function detectTypeFromHeader(header: Buffer): DetectedType | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpeg';
  if (header.length >= 8 && header.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (header.length >= 12 && header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (header.length >= 12 && header.toString('latin1', 4, 8) === 'ftyp') {
    const brand = header.toString('latin1', 8, 12);
    if (brand === QUICKTIME_BRAND) return 'mov';
    if (MP4_BRANDS.has(brand)) return 'mp4';
  }
  return null;
}

async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface ValidatedMedia {
  kind: 'foto' | 'video';
  mime: string;
  /** From the detected type only (never from the original file name). Fits the storage key rule. */
  extension: string;
  width: number;
  height: number;
  durationMs: number | null;
  format: string;
}

/**
 * Checks the magic bytes against the allow-list, then probes the file and cross-checks the two.
 * Throws UnsupportedMediaError, or the probe's own MediaProbeError.
 */
export async function validateMedia(params: { filePath: string; probe: MediaProbe }): Promise<ValidatedMedia> {
  const detected = detectTypeFromHeader(await readHeader(params.filePath));
  if (!detected) throw new UnsupportedMediaError('unsupported_type');
  const expected = TYPES[detected];

  const probed = await params.probe.probe(params.filePath);
  if (probed.kind !== expected.kind || probed.mime !== expected.mime) throw new UnsupportedMediaError('content_mismatch');

  return {
    kind: probed.kind,
    mime: probed.mime,
    extension: expected.extension,
    width: probed.width,
    height: probed.height,
    durationMs: probed.durationMs,
    format: probed.format,
  };
}
