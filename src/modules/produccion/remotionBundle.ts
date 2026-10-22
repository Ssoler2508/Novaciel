import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CapaTextoError, RemotionNoDisponibleError } from './errors.js';

// The Remotion bundle (Step 7c): the compositions of remotion/ compiled once into a static folder that the
// renderer serves from localhost. Built ONCE per process (a memoized promise) and cached on disk under a key
// made of everything that goes into it, so a restart does not rebundle and a change of source, version or
// font builds a new one.
//
// NETWORK OFF is enforced here: after bundling, a Content-Security-Policy is written into the bundle's
// index.html. The page can then load nothing but the bundle itself (its own origin), data: and blob:; a request
// to anywhere else is blocked by the browser BEFORE it leaves, and reported as a console message the adapter
// treats as a failure. (Checked with a reachable server in the spike: without the policy the page hit it,
// with it, never.)

/** Bump when the post-build steps below change, so older cached bundles are not reused. */
export const FORMATO_BUNDLE = 2;

/** Only the bundle's own origin, data: and blob:. No other host for anything (scripts, styles, images, fonts, fetch). */
export const POLITICA_CSP = [
  "default-src 'self' blob: data:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const META_CSP = `<meta http-equiv="Content-Security-Policy" content="${POLITICA_CSP}" />`;
/** The CSP does not cover DNS prefetch (a lookup leaks a host name without a request), so it is switched off too. */
export const META_DNS_PREFETCH = '<meta http-equiv="x-dns-prefetch-control" content="off" />';
const METAS_RED = `${META_CSP}${META_DNS_PREFETCH}`;
const PAQUETES_CLAVE = ['remotion', '@remotion/renderer', '@remotion/bundler', 'react', 'react-dom'] as const;
const FUENTES = ['inter-latin-400-normal.woff2', 'inter-latin-700-normal.woff2'] as const;

export interface OpcionesBundle {
  /** The project root: where node_modules/ with Remotion is. */
  raizProyecto: string;
  /** The folder with the Remotion entry (index.ts or index.tsx) and the compositions. */
  raizRemotion: string;
  /** The bundled fonts (assets/fonts). */
  carpetaFuentes: string;
  /** Where bundles are cached. */
  cacheDir: string;
  /** Replaces @remotion/bundler (tests). Receives the folders and returns the output folder. */
  empaquetar?: (o: { entryPoint: string; rootDir: string; outDir: string; publicDir: string }) => Promise<string>;
}

async function archivosDe(carpeta: string, base = carpeta): Promise<string[]> {
  const salida: string[] = [];
  for (const entrada of (await readdir(carpeta, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const ruta = path.join(carpeta, entrada.name);
    if (entrada.isDirectory()) salida.push(...(await archivosDe(ruta, base)));
    else salida.push(path.relative(base, ruta).split(path.sep).join('/'));
  }
  return salida;
}

async function versionDe(raizProyecto: string, paquete: string): Promise<string> {
  try {
    const json = JSON.parse(await readFile(path.join(raizProyecto, 'node_modules', paquete, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof json.version === 'string') return json.version;
  } catch {
    // fall through
  }
  throw new RemotionNoDisponibleError('paquete_ausente');
}

/** Everything that goes into the bundle, as one hash: sources, exact versions, fonts, the policy and the format. */
export async function claveDeBundle(o: Pick<OpcionesBundle, 'raizProyecto' | 'raizRemotion' | 'carpetaFuentes'>): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`formato:${FORMATO_BUNDLE}\0csp:${POLITICA_CSP}\0`);
  for (const paquete of PAQUETES_CLAVE) hash.update(`${paquete}@${await versionDe(o.raizProyecto, paquete)}\0`);
  for (const archivo of await archivosDe(o.raizRemotion)) {
    hash.update(`src:${archivo}\0`);
    hash.update(await readFile(path.join(o.raizRemotion, archivo)));
    hash.update('\0');
  }
  for (const fuente of FUENTES) {
    hash.update(`fuente:${fuente}\0`);
    hash.update(await readFile(path.join(o.carpetaFuentes, fuente)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function puntoDeEntrada(raizRemotion: string): string {
  for (const nombre of ['index.ts', 'index.tsx']) {
    const ruta = path.join(raizRemotion, nombre);
    if (existsSync(ruta)) return ruta;
  }
  throw new RemotionNoDisponibleError('paquete_ausente');
}

async function empaquetarConRemotion(o: { entryPoint: string; rootDir: string; outDir: string; publicDir: string }): Promise<string> {
  let modulo: typeof import('@remotion/bundler');
  try {
    modulo = await import('@remotion/bundler');
  } catch {
    throw new RemotionNoDisponibleError('paquete_ausente');
  }
  return modulo.bundle({ entryPoint: o.entryPoint, rootDir: o.rootDir, outDir: o.outDir, publicDir: o.publicDir });
}

/** True when the folder holds a finished bundle WITH the policy (a bundle without it is never reused). */
async function bundleValido(carpeta: string): Promise<boolean> {
  try {
    return (await readFile(path.join(carpeta, 'index.html'), 'utf8')).includes(METAS_RED);
  } catch {
    return false;
  }
}

async function construir(o: OpcionesBundle, destino: string): Promise<void> {
  const temporal = `${destino}.tmp-${randomUUID()}`;
  const publico = `${destino}.public-${randomUUID()}`;
  try {
    await mkdir(path.join(publico, 'fonts'), { recursive: true });
    for (const fuente of FUENTES) await cp(path.join(o.carpetaFuentes, fuente), path.join(publico, 'fonts', fuente));
    const empaquetar = o.empaquetar ?? empaquetarConRemotion;
    const salida = await empaquetar({ entryPoint: puntoDeEntrada(o.raizRemotion), rootDir: o.raizProyecto, outDir: temporal, publicDir: publico });
    // The post-build step: the policy and the DNS prefetch switch go into the page. Refuse a bundle where it did not take.
    const indice = path.join(salida, 'index.html');
    const html = await readFile(indice, 'utf8');
    if (!html.includes('<head>')) throw new CapaTextoError('fallo_de_bundle');
    await writeFile(indice, html.replace('<head>', `<head>${METAS_RED}`));
    if (!(await bundleValido(salida))) throw new CapaTextoError('fallo_de_bundle');
    try {
      await rename(salida, destino);
    } catch (error) {
      // Another process finished the same bundle first: use theirs.
      if (!(await bundleValido(destino))) throw error;
    }
  } catch (error) {
    if (error instanceof CapaTextoError || error instanceof RemotionNoDisponibleError) throw error;
    throw new CapaTextoError('fallo_de_bundle');
  } finally {
    await rm(temporal, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    await rm(publico, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

const enCurso = new Map<string, Promise<string>>();

/** Counts how many bundles this process really built (for tests and logs). */
export const estadisticasBundle = { construidos: 0 };

/**
 * The folder to serve (`serveUrl`): built once per process and cached on disk. A failed build is not remembered.
 * Throws CapaTextoError('fallo_de_bundle') or RemotionNoDisponibleError('paquete_ausente').
 */
export async function obtenerBundle(o: OpcionesBundle): Promise<string> {
  const clave = await claveDeBundle(o);
  const destino = path.join(o.cacheDir, `bundle-${clave.slice(0, 20)}`);
  let promesa = enCurso.get(destino);
  if (!promesa) {
    promesa = (async () => {
      await mkdir(o.cacheDir, { recursive: true });
      if (!(await bundleValido(destino))) {
        // An incomplete or old folder with that name is replaced.
        if (existsSync(destino) && (await stat(destino)).isDirectory()) await rm(destino, { recursive: true, force: true });
        await construir(o, destino);
        estadisticasBundle.construidos++;
      }
      return destino;
    })();
    enCurso.set(destino, promesa);
    promesa.catch(() => enCurso.delete(destino));
  }
  return promesa;
}
