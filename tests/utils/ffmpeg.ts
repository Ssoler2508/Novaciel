import { spawnSync } from 'node:child_process';
import { describe, it } from 'vitest';

// Tests that need the real FFmpeg and ffprobe must NOT skip silently. If a binary is missing they
// FAIL with a clear message, unless NOVACIEL_SKIP_FFMPEG_TESTS=1 is set: then they are skipped and a
// warning says so (vitest also lists them as skipped).

export const SKIP_FFMPEG_TESTS_VAR = 'NOVACIEL_SKIP_FFMPEG_TESTS';

const works = (command: string): boolean => spawnSync(command, ['-version'], { stdio: 'ignore', shell: false, windowsHide: true }).status === 0;
const skipRequested = (): boolean => process.env[SKIP_FFMPEG_TESTS_VAR] === '1';

function gated(needs: readonly string[]) {
  return (name: string, body: () => void): void => {
    if (skipRequested()) {
      // Printed by a passing test, because vitest shows the console output of tests, not of collection.
      describe(`${name} [skipped: ${SKIP_FFMPEG_TESTS_VAR}=1]`, () => {
        it('is skipped on purpose', () => {
          process.stderr.write(`[tests] SKIPPED: "${name}" needs ${needs.join(' and ')} on the PATH and ${SKIP_FFMPEG_TESTS_VAR}=1 is set.\n`);
        });
        describe.skip('skipped tests', body);
      });
      return;
    }
    const missing = needs.filter((command) => !works(command));
    if (missing.length > 0) {
      describe(name, () => {
        it(`needs ${missing.join(' and ')} on the PATH`, () => {
          throw new Error(`${missing.join(' and ')} not found on the PATH. Install FFmpeg, or set ${SKIP_FFMPEG_TESTS_VAR}=1 to skip the tests that need it.`);
        });
      });
      return;
    }
    describe(name, body);
  };
}

/** A describe block that needs both ffmpeg and ffprobe. */
export const describeFfmpeg = gated(['ffmpeg', 'ffprobe']);
/** A describe block that needs only ffprobe. */
export const describeFfprobe = gated(['ffprobe']);
