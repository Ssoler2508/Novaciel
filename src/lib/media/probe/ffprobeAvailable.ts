import { spawnSync } from 'node:child_process';

/** True when `<ffprobePath> -version` runs and succeeds. No shell; the output is discarded. */
export function isFfprobeAvailable(ffprobePath: string): boolean {
  try {
    const result = spawnSync(ffprobePath, ['-version'], { stdio: 'ignore', shell: false, timeout: 10_000, windowsHide: true });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}
