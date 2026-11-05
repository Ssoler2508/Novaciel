import { existsSync } from 'node:fs';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import type { CapaRenderizada, CapaTextoAnimado, EntradaCapa, OpcionesCapa } from './capaTexto.js';
import { nombreFotogramaCapa, PATRON_CAPA } from './capaTexto.js';
import { CapaTextoError, RemotionNoDisponibleError } from './errors.js';
import { directorioDeFuentes } from './fonts.js';
import { procesosReales, type ProcesosNavegador } from './navegadorProcesos.js';
import { esquemaPropsPlantilla } from './propsPlantilla.js';
import { obtenerBundle, type OpcionesBundle } from './remotionBundle.js';
import { exigirLicenciaRemotion, type LicenciaRemotion } from './remotionLicencia.js';

// The Remotion adapter of the CapaTextoAnimado port (Step 7c). It draws ONE scene's transparent text layer as a
// PNG sequence into a folder the caller owns, with Remotion's Node API (never the CLI: client text travels only
// as `inputProps`, a JSON object rendered as React text). Remotion draws text and shapes; it never sees a photo
// or a video. Nothing is downloaded while rendering (the browser is the one `npm run remotion:browser` fetched,
// given by its explicit path) and the page cannot reach the network (a Content-Security-Policy in the bundle).
//
// Order of every call: license -> input checks -> browser and packages present -> bundle (once per process) ->
// render with a time limit -> normalize and verify the frames. Any failure leaves no frames behind and closes the
// browser. Errors and logs carry ids, the template and counts, NEVER the text.
//
// `renderizar` always settles within `timeoutMs` plus a bounded cleanup margin (see `margenDeLimpieza`), whatever
// Remotion or the browser do: every wait after the time limit is bounded, a browser that does not close is killed
// by its process id, and a render that still does not unwind is abandoned (its late frames are removed when it
// ends). Before this, `browser.close()` and the render itself were awaited without a limit: Remotion's `close()`
// kills the process and then asks the dead browser for its pages, which can wait forever.

/** What this adapter needs from @remotion/renderer. A fake can stand in for it (tests). */
export interface NavegadorRemotion {
  close(opciones?: { silent: boolean }): Promise<unknown>;
}
export interface LogNavegador {
  type: string;
  text: string;
}
export interface RendererRemotion {
  openBrowser(navegador: 'chrome', opciones: { browserExecutable: string; logLevel: 'error' }): Promise<NavegadorRemotion>;
  selectComposition(opciones: {
    serveUrl: string;
    id: string;
    inputProps: Record<string, unknown>;
    puppeteerInstance: NavegadorRemotion;
    onBrowserLog: (log: LogNavegador) => void;
  }): Promise<unknown>;
  renderFrames(opciones: {
    serveUrl: string;
    composition: unknown;
    inputProps: Record<string, unknown>;
    outputDir: string;
    imageFormat: 'png';
    imageSequencePattern: string;
    puppeteerInstance: NavegadorRemotion;
    concurrency: number;
    timeoutInMilliseconds: number;
    cancelSignal: unknown;
    onStart: () => void;
    onBrowserLog: (log: LogNavegador) => void;
  }): Promise<{ frameCount: number }>;
  makeCancelSignal(): { cancelSignal: unknown; cancel: () => void };
}

export interface OpcionesCapaTextoRemotion {
  /** The declared license (config.remotion.licencia). Unset: every call refuses. */
  licencia: LicenciaRemotion | undefined;
  /** Absolute path of the browser executable; by default the one downloaded into node_modules/.remotion. */
  navegador?: string | undefined;
  raizProyecto?: string;
  /** The folder with the Remotion entry and compositions. Default: remotion/ at the project root. */
  raizRemotion?: string;
  cacheDir?: string;
  /** Browser tabs rendering in parallel. Default: half the CPU threads, at most 4. */
  concurrencia?: number;
  /** Bounds of the cleanup after a failed or timed-out render. Defaults: `LIMPIEZA_POR_DEFECTO`. */
  limpieza?: Partial<LimpiezaMs>;
  logger?: Logger;
  deps?: {
    /** Lists and kills browser processes (the real one by default; a fake in tests). */
    procesos?: ProcesosNavegador;
    /** Where Remotion and its browser create temporary folders. Default: the OS temp directory. */
    directorioTemporal?: string;
    renderer?: RendererRemotion;
    obtenerBundle?: (o: OpcionesBundle) => Promise<string>;
    existeNavegador?: (ruta: string) => boolean;
    empaquetar?: OpcionesBundle['empaquetar'];
  };
}

/** The project root, found by walking up from this file until package.json and remotion/ are both there. */
export function raizDelProyecto(): string {
  let carpeta = path.dirname(fileURLToPath(import.meta.url));
  for (let nivel = 0; nivel < 8; nivel++) {
    if (existsSync(path.join(carpeta, 'package.json')) && existsSync(path.join(carpeta, 'remotion'))) return carpeta;
    const padre = path.dirname(carpeta);
    if (padre === carpeta) break;
    carpeta = padre;
  }
  throw new RemotionNoDisponibleError('paquete_ausente');
}

/** Where `npm run remotion:browser` puts Chrome Headless Shell on this machine. */
export function rutaNavegadorDescargado(raizProyecto: string, plataforma: NodeJS.Platform = process.platform, arquitectura: string = process.arch): string {
  const nombre =
    plataforma === 'win32' ? 'win64' : plataforma === 'linux' ? (arquitectura === 'arm64' ? 'linux-arm64' : 'linux64') : plataforma === 'darwin' ? (arquitectura === 'arm64' ? 'mac-arm64' : 'mac-x64') : null;
  if (nombre === null) throw new RemotionNoDisponibleError('navegador_ausente');
  const ejecutable = plataforma === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  return path.join(raizProyecto, 'node_modules', '.remotion', 'chrome-headless-shell', nombre, `chrome-headless-shell-${nombre}`, ejecutable);
}

async function cargarRenderer(): Promise<RendererRemotion> {
  try {
    return (await import('@remotion/renderer')) as unknown as RendererRemotion;
  } catch {
    throw new RemotionNoDisponibleError('paquete_ausente');
  }
}

/** Remotion composition ids accept letters, digits and "-" only. */
export const idComposicionRemotion = (plantilla: string, version: number): string => `${plantilla.replace(/_/g, '-')}-v${version}`;

// ---- frames on disk ----------------------------------------------------------------------------

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface CabeceraPng {
  ancho: number;
  alto: number;
  profundidad: number;
  tipoDeColor: number;
  /** True when the pixels carry transparency: RGBA, gray+alpha, or a palette with a tRNS chunk. */
  conAlfa: boolean;
}

/** Reads the PNG header (and the chunk names up to the first IDAT). Returns null when it is not a PNG. */
export function leerCabeceraPng(bytes: Buffer): CabeceraPng | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(FIRMA_PNG) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const tipoDeColor = bytes[25]!;
  let conAlfa = tipoDeColor === 6 || tipoDeColor === 4;
  if (tipoDeColor === 3) {
    for (let pos = 33; pos + 8 <= bytes.length; ) {
      const largo = bytes.readUInt32BE(pos);
      const tipo = bytes.toString('ascii', pos + 4, pos + 8);
      if (tipo === 'tRNS') conAlfa = true;
      if (tipo === 'IDAT') break;
      pos += 12 + largo;
    }
  }
  return { ancho: bytes.readUInt32BE(16), alto: bytes.readUInt32BE(20), profundidad: bytes[24]!, tipoDeColor, conAlfa };
}

async function primerosBytes(ruta: string, cuantos = 4096): Promise<Buffer> {
  const handle = await open(ruta, 'r');
  try {
    const buffer = Buffer.alloc(cuantos);
    const { bytesRead } = await handle.read(buffer, 0, cuantos, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Deletes the frames of the layer in the folder (not the folder: the caller owns it). */
export async function borrarCapas(carpeta: string): Promise<void> {
  let nombres: string[] = [];
  try {
    nombres = await readdir(carpeta);
  } catch {
    return;
  }
  await Promise.all(
    nombres.filter((n) => /^capa-\d+\.png$/.test(n)).map((n) => rm(path.join(carpeta, n), { force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)),
  );
}

/**
 * Remotion names the frames capa-0.png, capa-1.png... (the padding is not documented). Renames them to the
 * contract capa-00000.png... and checks the count and, for EVERY frame, that it is a PNG of the right size with
 * transparency. Throws CapaTextoError('salida_incompleta').
 */
export async function normalizarCapas(carpeta: string, esperado: { fotogramas: number; ancho: number; alto: number }): Promise<void> {
  const nombres = (await readdir(carpeta)).filter((n) => /^capa-\d+\.png$/.test(n));
  const numeros = nombres.map((n) => ({ n, indice: Number(/^capa-(\d+)\.png$/.exec(n)![1]) })).sort((a, b) => a.indice - b.indice);
  if (numeros.length !== esperado.fotogramas || numeros.some((x, i) => x.indice !== i)) throw new CapaTextoError('salida_incompleta');
  for (const { n, indice } of numeros) {
    const destino = nombreFotogramaCapa(indice);
    if (n !== destino) await rename(path.join(carpeta, n), path.join(carpeta, destino));
  }
  for (let i = 0; i < esperado.fotogramas; i++) {
    const cabecera = leerCabeceraPng(await primerosBytes(path.join(carpeta, nombreFotogramaCapa(i))));
    if (!cabecera || !cabecera.conAlfa || cabecera.ancho !== esperado.ancho || cabecera.alto !== esperado.alto) throw new CapaTextoError('salida_incompleta');
  }
}

// ---- bounded cleanup ---------------------------------------------------------------------------

/** How long each step of the cleanup after a failed or timed-out render may take. All in milliseconds. */
export interface LimpiezaMs {
  /** Waiting for `browser.close()`. */
  cierreMs: number;
  /** Listing or killing browser processes (each). */
  procesoMs: number;
  /** Waiting for the render to unwind after the cancel and the close. */
  trabajoMs: number;
  /** Removing the temporary folders left by this render. */
  temporalesMs: number;
}

export const LIMPIEZA_POR_DEFECTO: LimpiezaMs = { cierreMs: 3_000, procesoMs: 2_000, trabajoMs: 3_000, temporalesMs: 2_000 };

/** The most the cleanup can add to `timeoutMs`: `renderizar` settles within `timeoutMs + margenDeLimpieza()`. */
export function margenDeLimpieza(limpieza: LimpiezaMs = LIMPIEZA_POR_DEFECTO): number {
  // close + list + kill + list again + render unwinding + temporary folders, and 2 s for the folder of frames.
  return limpieza.cierreMs + 3 * limpieza.procesoMs + limpieza.trabajoMs + limpieza.temporalesMs + 2_000;
}

type Acabado<T> = { estado: 'ok'; valor: T } | { estado: 'error' } | { estado: 'limite' };

/** Waits for `promesa` at most `ms`. Never rejects and never waits longer; a promise that ends later is ignored. */
function conLimite<T>(promesa: Promise<T>, ms: number): Promise<Acabado<T>> {
  return new Promise((resolve) => {
    const temporizador = setTimeout(() => resolve({ estado: 'limite' }), ms);
    promesa.then(
      (valor) => {
        clearTimeout(temporizador);
        resolve({ estado: 'ok', valor });
      },
      () => {
        clearTimeout(temporizador);
        resolve({ estado: 'error' });
      },
    );
  });
}

/** Opening a browser is done one at a time per process, so the processes it creates can be told apart. */
let colaApertura: Promise<unknown> = Promise.resolve();
const LIMITE_APERTURA_MS = 30_000;
function enSerie<T>(tarea: () => Promise<T>): Promise<T> {
  let real: Promise<T> | undefined;
  const turno = colaApertura.then(() => {
    real = tarea();
    return conLimite(real, LIMITE_APERTURA_MS); // a browser that never opens cannot block the next render for ever
  });
  colaApertura = turno;
  return turno.then(() => real!);
}

/** Renders and folders that are running in this process now: a temporary folder is only removed when it is alone. */
let rendersActivos = 0;
const carpetasActivas = new Set<string>();

// The temporary folders Remotion creates in the OS temp directory: the browser profile and the assets folder of
// the render. Matching is strict (exact prefixes, a plain directory, directly inside the temp directory).
const TEMPORAL_DE_REMOTION = /^(puppeteer_dev_chrome_profile-|remotion-v\d+\.\d+\.\d+[\w.-]*-assets)[\w-]*$/;

async function nombresTemporales(directorio: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(directorio)).filter((n) => TEMPORAL_DE_REMOTION.test(n)));
  } catch {
    return new Set();
  }
}

/**
 * Removes the Remotion temporary folders that appeared since `antes` (the list taken before this render opened
 * its browser). Only when this is the only render running in the process: otherwise a new folder may belong to
 * another render. A folder that was already there is never touched. Returns how many it removed.
 */
async function borrarTemporalesNuevos(directorio: string, antes: ReadonlySet<string>): Promise<number> {
  if (rendersActivos > 1) return 0;
  let borrados = 0;
  for (const nombre of await nombresTemporales(directorio)) {
    if (antes.has(nombre)) continue;
    const ruta = path.join(directorio, nombre);
    try {
      const info = await lstat(ruta);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      await rm(ruta, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      borrados++;
    } catch {
      // leave it: a leftover temporary folder is not worth failing a cleanup
    }
  }
  return borrados;
}

// ---- the adapter -------------------------------------------------------------------------------

const VIOLACION_CSP = /Content Security Policy/i;

export function crearCapaTextoRemotion(opciones: OpcionesCapaTextoRemotion): CapaTextoAnimado {
  const log = opciones.logger ?? defaultLogger;
  const renderizarUna = {
    async renderizar(entrada: EntradaCapa, { carpeta, timeoutMs }: OpcionesCapa): Promise<CapaRenderizada> {
      // 1. The license gate: nothing else starts without it.
      exigirLicenciaRemotion({ remotion: { licencia: opciones.licencia } });

      // 2. The input: the strict schema of the template, and consistency with the entry.
      const analizado = esquemaPropsPlantilla.safeParse(entrada.props);
      if (!analizado.success) throw new CapaTextoError('entrada_invalida');
      const props = analizado.data;
      if (
        props.plantilla !== entrada.plantilla ||
        props.version !== entrada.version ||
        props.ancho !== entrada.ancho ||
        props.alto !== entrada.alto ||
        props.fps !== entrada.fps ||
        props.fotogramas !== entrada.fotogramas ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0
      ) {
        throw new CapaTextoError('entrada_invalida');
      }

      // 3. The browser (explicit path, never downloaded here) and the packages.
      const raizProyecto = opciones.raizProyecto ?? raizDelProyecto();
      const navegador = opciones.navegador ?? rutaNavegadorDescargado(raizProyecto);
      if (!(opciones.deps?.existeNavegador ?? existsSync)(navegador)) throw new RemotionNoDisponibleError('navegador_ausente');
      const renderer = opciones.deps?.renderer ?? (await cargarRenderer());

      // 4. The bundle: once per process, cached on disk.
      const opcionesBundle: OpcionesBundle = {
        raizProyecto,
        raizRemotion: opciones.raizRemotion ?? path.join(raizProyecto, 'remotion'),
        carpetaFuentes: directorioDeFuentes(),
        cacheDir: opciones.cacheDir ?? path.join(raizProyecto, '.data', 'remotion'),
        ...(opciones.deps?.empaquetar ? { empaquetar: opciones.deps.empaquetar } : {}),
      };
      const serveUrl = await (opciones.deps?.obtenerBundle ?? obtenerBundle)(opcionesBundle);

      // 5. The render, with a time limit.
      const inicio = Date.now();
      const limpieza: LimpiezaMs = { ...LIMPIEZA_POR_DEFECTO, ...opciones.limpieza };
      const procesos = opciones.deps?.procesos ?? procesosReales;
      const directorioTemporal = opciones.deps?.directorioTemporal ?? os.tmpdir();
      const temporalesAntes = await nombresTemporales(directorioTemporal);
      const { cancelSignal, cancel } = renderer.makeCancelSignal();
      let navegadorAbierto: NavegadorRemotion | null = null;
      /** The browser's own process ids (taken when it opened), to kill it if it does not close. */
      let procesosPropios: number[] = [];
      /** Set when the time is up: work that has not started must not start. */
      let abortado = false;
      let violacion = false;
      const alLog = (l: LogNavegador) => {
        if (VIOLACION_CSP.test(l.text)) violacion = true;
      };
      const inputProps = props as unknown as Record<string, unknown>;
      const trabajo = (async () => {
        try {
          navegadorAbierto = await enSerie(async () => {
            const antes = new Set(await procesos.listar(navegador));
            const abierto = await renderer.openBrowser('chrome', { browserExecutable: navegador, logLevel: 'error' });
            procesosPropios = (await procesos.listar(navegador)).filter((pid) => !antes.has(pid));
            return abierto;
          });
          if (abortado) throw new CapaTextoError('tiempo_agotado');
          const composition = await renderer.selectComposition({
            serveUrl,
            id: idComposicionRemotion(props.plantilla, props.version),
            inputProps,
            puppeteerInstance: navegadorAbierto,
            onBrowserLog: alLog,
          });
          if (abortado) throw new CapaTextoError('tiempo_agotado');
          await renderer.renderFrames({
            serveUrl,
            composition,
            inputProps,
            outputDir: carpeta,
            imageFormat: 'png',
            imageSequencePattern: 'capa-[frame].[ext]',
            puppeteerInstance: navegadorAbierto,
            concurrency: opciones.concurrencia ?? Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
            // Only a safety net inside the page: more room than our own limit, so that the limit above decides, and
            // never under 7000, the minimum Remotion accepts (it throws a TypeError below that).
            timeoutInMilliseconds: Math.max(7_000, Math.min(60_000, timeoutMs + 2_000)),
            cancelSignal,
            onStart: () => undefined,
            onBrowserLog: alLog,
          });
        } finally {
          // Bounded: Remotion's close() can wait for ever for a browser it has already killed.
          const abierto = navegadorAbierto as NavegadorRemotion | null;
          if (abierto) await conLimite(abierto.close({ silent: true }), limpieza.cierreMs);
        }
      })();

      let agotado = false;
      let temporizador: NodeJS.Timeout | undefined;
      const limite = new Promise<never>((_resolve, reject) => {
        temporizador = setTimeout(() => {
          agotado = true;
          reject(new CapaTextoError('tiempo_agotado'));
        }, timeoutMs);
      });
      let fallo: unknown;
      try {
        await Promise.race([trabajo, limite]);
      } catch (error) {
        fallo = error;
      } finally {
        clearTimeout(temporizador);
      }
      if (fallo !== undefined) {
        // Stop the work and close the browser, wait for the work to end, then remove what it wrote. Every wait is
        // bounded (see margenDeLimpieza): a browser that does not close is killed, a render that does not end is
        // abandoned and its late frames are removed when it does.
        abortado = true;
        try {
          cancel();
        } catch {
          // the cancel signal is a best effort; the close below stops the work anyway
        }
        const abierto = navegadorAbierto as NavegadorRemotion | null;
        const cierre = await conLimite(abierto ? abierto.close({ silent: true }) : Promise.resolve(), limpieza.cierreMs);
        // The browser did not close in time, or its processes outlived the close: kill the ones this render opened.
        let forzado = cierre.estado === 'limite';
        if (!forzado && procesosPropios.length > 0) {
          const vivos = await conLimite(procesos.listar(navegador), limpieza.procesoMs);
          forzado = vivos.estado !== 'ok' || vivos.valor.some((pid) => procesosPropios.includes(pid));
        }
        if (forzado && procesosPropios.length > 0) await conLimite(procesos.matar(procesosPropios), limpieza.procesoMs);
        const fin = await conLimite(trabajo, limpieza.trabajoMs);
        if (fin.estado === 'limite') {
          log.warn({ plantilla: props.plantilla, version: props.version, ms: Date.now() - inicio }, 'text layer render abandoned after the time limit');
          // Whatever it writes when it finally ends goes away too, unless the folder is in use by another render.
          void trabajo.then(
            () => (carpetasActivas.has(carpeta) ? undefined : borrarCapas(carpeta)),
            () => (carpetasActivas.has(carpeta) ? undefined : borrarCapas(carpeta)),
          );
        }
        await borrarCapas(carpeta);
        await conLimite(borrarTemporalesNuevos(directorioTemporal, temporalesAntes), limpieza.temporalesMs);
        // Remotion has its own time limit, equal to ours: under load it can fail a hair before our timer fires.
        if (agotado || Date.now() - inicio >= timeoutMs) throw new CapaTextoError('tiempo_agotado');
        if (violacion) throw new CapaTextoError('solicitud_externa');
        if (fallo instanceof CapaTextoError || fallo instanceof RemotionNoDisponibleError) throw fallo;
        log.error({ plantilla: props.plantilla, version: props.version, errorName: fallo instanceof Error ? fallo.name : 'UnknownError' }, 'text layer render failed');
        throw new CapaTextoError('fallo_de_render');
      }
      if (violacion) {
        await borrarCapas(carpeta);
        throw new CapaTextoError('solicitud_externa');
      }

      // 6. Normalize and verify every frame.
      try {
        await normalizarCapas(carpeta, { fotogramas: props.fotogramas, ancho: props.ancho, alto: props.alto });
      } catch (error) {
        await borrarCapas(carpeta);
        throw error instanceof CapaTextoError ? error : new CapaTextoError('salida_incompleta');
      }
      log.info({ plantilla: props.plantilla, version: props.version, fotogramas: props.fotogramas, ms: Date.now() - inicio }, 'text layer rendered');
      return { carpeta, patron: PATRON_CAPA, fotogramas: props.fotogramas, ancho: props.ancho, alto: props.alto };
    },
  };
  return {
    // Counts the renders and folders in use by this process (the cleanup of temporary folders needs to know).
    async renderizar(entrada: EntradaCapa, opcionesCapa: OpcionesCapa): Promise<CapaRenderizada> {
      rendersActivos++;
      carpetasActivas.add(opcionesCapa.carpeta);
      try {
        return await renderizarUna.renderizar(entrada, opcionesCapa);
      } finally {
        rendersActivos--;
        carpetasActivas.delete(opcionesCapa.carpeta);
      }
    },
  };
}
