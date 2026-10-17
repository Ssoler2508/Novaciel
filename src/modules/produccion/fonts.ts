import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts } from '@napi-rs/canvas';

// The bundled font (Inter, SIL OFL 1.1: assets/fonts/) and its registration with the canvas. Its glyph
// coverage (the single table that says which characters a slide may carry) is in glyphCoverage.ts, so
// the renderer (last guard) and the brief schema (upstream) use the same one.

/** The family name the renderer draws with by default. */
export const FUENTE_POR_DEFECTO = 'Inter';

const ARCHIVOS = [
  { archivo: 'inter-latin-400-normal.woff2', peso: 400 },
  { archivo: 'inter-latin-700-normal.woff2', peso: 700 },
] as const;

// The coverage table and its checks are in glyphCoverage.ts (pure, no canvas); re-exported here.
export { assertGlifosSoportados, COBERTURA_INTER_LATIN, contarGlifosNoSoportados, esTextoSoportado } from './glyphCoverage.js';

/**
 * The folder with the bundled fonts. Found by walking up from this file until assets/fonts/OFL.txt
 * exists, so it works from the sources (tsx, vitest) and from the compiled dist/src alike.
 */
export function directorioDeFuentes(): string {
  let carpeta = path.dirname(fileURLToPath(import.meta.url));
  for (let nivel = 0; nivel < 8; nivel++) {
    const candidata = path.join(carpeta, 'assets', 'fonts');
    if (existsSync(path.join(candidata, 'OFL.txt'))) return candidata;
    const padre = path.dirname(carpeta);
    if (padre === carpeta) break;
    carpeta = padre;
  }
  throw new Error('The bundled fonts folder (assets/fonts) was not found');
}

let registradas = false;

/** Registers Inter Regular and Bold with the canvas under the family "Inter". Safe to call many times. */
export function registrarFuentes(): void {
  if (registradas) return;
  const carpeta = directorioDeFuentes();
  for (const { archivo } of ARCHIVOS) {
    if (!GlobalFonts.registerFromPath(path.join(carpeta, archivo), FUENTE_POR_DEFECTO)) {
      throw new Error(`The bundled font ${archivo} could not be registered`);
    }
  }
  registradas = true;
}
