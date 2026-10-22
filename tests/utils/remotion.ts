import { existsSync } from 'node:fs';
import { describe, it } from 'vitest';
import { raizDelProyecto, rutaNavegadorDescargado } from '../../src/modules/produccion/remotionCapaTexto.js';

// Tests that render with the REAL Remotion and its Chrome Headless Shell must NOT skip silently. If the browser
// was not downloaded they FAIL with a clear message, unless NOVACIEL_SKIP_REMOTION_TESTS=1 is set: then they are
// skipped and a warning says so (vitest also lists them as skipped). Same rule as the FFmpeg tests.

export const SKIP_REMOTION_TESTS_VAR = 'NOVACIEL_SKIP_REMOTION_TESTS';

export function navegadorDeLasPruebas(): string {
  return process.env.REMOTION_NAVEGADOR || rutaNavegadorDescargado(raizDelProyecto());
}

export function describeRemotion(name: string, body: () => void): void {
  if (process.env[SKIP_REMOTION_TESTS_VAR] === '1') {
    describe(`${name} [skipped: ${SKIP_REMOTION_TESTS_VAR}=1]`, () => {
      it('is skipped on purpose', () => {
        process.stderr.write(`[tests] SKIPPED: "${name}" needs Remotion's Chrome Headless Shell and ${SKIP_REMOTION_TESTS_VAR}=1 is set.\n`);
      });
      describe.skip('skipped tests', body);
    });
    return;
  }
  if (!existsSync(navegadorDeLasPruebas())) {
    describe(name, () => {
      it('needs the Chrome Headless Shell of Remotion', () => {
        throw new Error(`The browser is missing. Run "npm run remotion:browser" once (it needs the network), or set ${SKIP_REMOTION_TESTS_VAR}=1 to skip the tests that need it.`);
      });
    });
    return;
  }
  describe(name, body);
}
