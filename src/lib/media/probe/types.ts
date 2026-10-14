// Media probe: reads the technical facts of a file (kind, format, size, duration) by looking at its
// content, never at its name or declared type. The real implementation runs ffprobe.

export interface ProbeResult {
  kind: 'foto' | 'video';
  /** The container/demuxer name reported by ffprobe, for example "mov,mp4,m4a,3gp,3g2,mj2". */
  format: string;
  /** Detected MIME type, for example "image/jpeg" or "video/mp4". */
  mime: string;
  /** Displayed size: already swapped when a video is rotated by 90 or 270 degrees. */
  width: number;
  height: number;
  /** Videos only; null for photos. */
  durationMs: number | null;
}

export interface MediaProbe {
  probe(filePath: string): Promise<ProbeResult>;
}

export type MediaProbeErrorCode =
  | 'not_found' // the ffprobe executable could not be started
  | 'timeout'
  | 'exit_nonzero'
  | 'output_too_large'
  | 'parse'; // ffprobe ran but its output is unreadable or not a supported photo/video

/**
 * A failed probe. The message is fixed text (plus the exit code): ffprobe's stderr, the file name
 * and the file content never go into it.
 */
export class MediaProbeError extends Error {
  constructor(
    readonly code: MediaProbeErrorCode,
    readonly exitCode?: number,
  ) {
    super(
      {
        not_found: 'ffprobe could not be started',
        timeout: 'ffprobe timed out',
        exit_nonzero: `ffprobe failed with exit code ${exitCode ?? 'unknown'}`,
        output_too_large: 'ffprobe output was too large',
        parse: 'ffprobe output could not be understood',
      }[code],
    );
    this.name = 'MediaProbeError';
  }
}
