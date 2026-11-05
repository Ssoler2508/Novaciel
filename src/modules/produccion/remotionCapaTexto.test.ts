import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { pino } from 'pino';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PropsCapa } from '../../../remotion/tipos.js';
import { FakeCapaTextoAnimado, nombreFotogramaCapa, renderizarCapaEscena } from './capaTexto.js';
import { elegirColores } from './colors.js';
import { CapaTextoError, RemotionLicenciaNoConfiguradaError, RemotionNoDisponibleError, UnsupportedGlyphsError } from './errors.js';
import { construirPropsPlantilla, type PropsPlantilla } from './propsPlantilla.js';
import { claveDeBundle, FORMATO_BUNDLE, obtenerBundle, META_DNS_PREFETCH, POLITICA_CSP, type OpcionesBundle } from './remotionBundle.js';
import {
  borrarCapas,
  crearCapaTextoRemotion,
  idComposicionRemotion,
  leerCabeceraPng,
  margenDeLimpieza,
  normalizarCapas,
  rutaNavegadorDescargado,
  type LogNavegador,
  type NavegadorRemotion,
  type RendererRemotion,
} from './remotionCapaTexto.js';
import type { Medir } from './textLayout.js';
import { directorioDeFuentes } from './fonts.js';
import type { ProcesosNavegador } from './navegadorProcesos.js';

// The adapter without a browser: Remotion's functions are replaced by a fake that writes frames into the folder.
// The REAL Chromium is in remotionCapaTexto.render.test.ts.

const SECRETO = 'TEXTO-SECRETO-DEL-CLIENTE';
const medir: Medir = (t, s) => [...t].length * s * 0.5;
const colores = elegirColores({ colores: { principal: '#1f3a5f', secundarios: ['#f4e9d8'], acento: '#e07a3f' } });

function propsDe(texto = `Cada mañana ${SECRETO} tostamos`, fotogramas = 12, plantilla = 'palabra_a_palabra'): PropsPlantilla {
  return construirPropsPlantilla({ plantilla: { id: plantilla, version: 1 }, escena: { orden: 2, texto, fotogramas }, fps: 30, colores, ancho: 1080, alto: 1920, medir })!;
}
const entradaDe = (props: PropsPlantilla, extra: Partial<{ fotogramas: number }> = {}) => ({
  plantilla: props.plantilla,
  version: props.version,
  props,
  ancho: props.ancho,
  alto: props.alto,
  fps: props.fps,
  fotogramas: extra.fotogramas ?? props.fotogramas,
});

// ---- a fake Remotion ---------------------------------------------------------------------------

type Modo = 'ok' | 'sin_padding' | 'con_padding' | 'falta_un_fotograma' | 'sin_alfa' | 'tamano_malo' | 'falla' | 'cuelga' | 'no_termina' | 'falla_pasado_el_limite' | 'violacion_csp';

class FakeRenderer implements RendererRemotion {
  modo: Modo = 'ok';
  aperturas = 0;
  cierres = 0;
  /** `close()` never returns (Remotion's close can wait for ever for a browser it already killed). */
  cierreCuelga = false;
  /** The browser takes this long to open. */
  retrasoApertura = 0;
  /** Runs while the browser opens (to create processes or temporary folders, as the real one does). */
  alAbrir: (() => Promise<void>) | null = null;
  /** Runs when `close()` is called. */
  alCerrar: (() => void) | null = null;
  /** Mode `no_termina`: the render ignores cancel and close and ends only when the test says so. */
  private terminarRender: (() => void) | null = null;
  escritoTardio = false;
  composiciones: string[] = [];
  inputProps: Record<string, unknown>[] = [];
  cancelado = false;
  limitesInternos: number[] = [];
  private liberar: (() => void) | null = null;

  /** Releases a render that is waiting in mode `cuelga` (as killing the browser does). */
  soltar(): void {
    this.liberar?.();
  }

  /** Lets a render in mode `no_termina` end. */
  terminar(): void {
    this.terminarRender?.();
  }

  async openBrowser(): Promise<NavegadorRemotion> {
    this.aperturas++;
    if (this.retrasoApertura > 0) await new Promise((r) => setTimeout(r, this.retrasoApertura));
    await this.alAbrir?.();
    return {
      close: async () => {
        this.cierres++;
        this.alCerrar?.();
        if (this.cierreCuelga) return new Promise<never>(() => undefined);
        this.liberar?.();
        return undefined;
      },
    };
  }

  async selectComposition(o: { id: string; inputProps: Record<string, unknown> }): Promise<unknown> {
    this.composiciones.push(o.id);
    this.inputProps.push(o.inputProps);
    return { id: o.id, ...o.inputProps };
  }

  async renderFrames(o: { composition: unknown; outputDir: string; timeoutInMilliseconds: number; onBrowserLog: (l: LogNavegador) => void }): Promise<{ frameCount: number }> {
    this.limitesInternos.push(o.timeoutInMilliseconds);
    const c = o.composition as { fotogramas: number; ancho: number; alto: number };
    const png = createCanvas(this.modo === 'tamano_malo' ? c.ancho - 1 : c.ancho, c.alto).toBuffer('image/png');
    const sinAlfa = await sharp({ create: { width: c.ancho, height: c.alto, channels: 3, background: '#000000' } }).png().toBuffer();
    const escribir = async (n: number, bytes: Buffer) => {
      const nombre = this.modo === 'con_padding' ? nombreFotogramaCapa(n) : `capa-${n}.png`;
      await writeFile(path.join(o.outputDir, nombre), bytes);
    };
    if (this.modo === 'falla') {
      await escribir(0, png);
      throw new Error(`boom ${SECRETO}`);
    }
    if (this.modo === 'falla_pasado_el_limite') {
      // Blocks the event loop past the limit, then fails: the renderer's own timeout winning the race with ours.
      const hasta = Date.now() + 250;
      while (Date.now() < hasta);
      throw new Error('renderer timeout');
    }
    if (this.modo === 'cuelga') {
      await escribir(0, png);
      await new Promise<void>((resolve) => {
        this.liberar = resolve;
      });
      throw new Error('browser closed');
    }
    if (this.modo === 'no_termina') {
      await escribir(0, png);
      await new Promise<void>((resolve) => {
        this.terminarRender = resolve;
      });
      await escribir(1, png); // written after the adapter gave up
      this.escritoTardio = true;
      throw new Error('late end');
    }
    if (this.modo === 'violacion_csp') o.onBrowserLog({ type: 'error', text: "Loading the image 'https://example.invalid/x.png' violates the following Content Security Policy directive: \"img-src 'self'\"." });
    for (let i = 0; i < c.fotogramas; i++) {
      if (this.modo === 'falta_un_fotograma' && i === 3) continue;
      await escribir(i, this.modo === 'sin_alfa' ? sinAlfa : png);
    }
    return { frameCount: c.fotogramas };
  }

  makeCancelSignal() {
    return { cancelSignal: {}, cancel: () => void (this.cancelado = true) };
  }
}

// ---- a temporary project for the bundle --------------------------------------------------------

interface Proyecto {
  raiz: string;
  remotion: string;
  cache: string;
  opciones: OpcionesBundle;
  empaquetados: number;
}

async function crearProyecto(): Promise<Proyecto> {
  const raiz = await mkdtemp(path.join(os.tmpdir(), 'novaciel-remotion-test-'));
  const remotion = path.join(raiz, 'remotion');
  await mkdir(remotion, { recursive: true });
  await writeFile(path.join(remotion, 'index.ts'), 'export {};\n');
  await writeFile(path.join(remotion, 'Root.tsx'), 'export const Root = null;\n');
  for (const paquete of ['remotion', '@remotion/renderer', '@remotion/bundler', 'react', 'react-dom']) {
    await mkdir(path.join(raiz, 'node_modules', paquete), { recursive: true });
    await writeFile(path.join(raiz, 'node_modules', paquete, 'package.json'), JSON.stringify({ name: paquete, version: '1.0.0' }));
  }
  const proyecto: Proyecto = {
    raiz,
    remotion,
    cache: path.join(raiz, 'cache'),
    empaquetados: 0,
    opciones: {
      raizProyecto: raiz,
      raizRemotion: remotion,
      carpetaFuentes: directorioDeFuentes(),
      cacheDir: path.join(raiz, 'cache'),
      empaquetar: async ({ outDir }) => {
        proyecto.empaquetados++;
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, 'index.html'), '<!DOCTYPE html><html><head><title>x</title></head><body></body></html>');
        return outDir;
      },
    },
  };
  return proyecto;
}

/** The operating system's browser processes, faked: a list that kills remove from. */
class FakeProcesos implements ProcesosNavegador {
  vivos: number[] = [100]; // 100: a browser of someone else, never ours
  muertos: number[][] = [];
  async listar(): Promise<number[]> {
    return [...this.vivos];
  }
  async matar(pids: readonly number[]): Promise<void> {
    this.muertos.push([...pids]);
    this.vivos = this.vivos.filter((p) => !pids.includes(p));
  }
}

let proyecto: Proyecto;
let carpeta: string;
let renderer: FakeRenderer;
let procesos: FakeProcesos;
/** A private "OS temp directory" for Remotion's temporary folders, so the tests never touch the real one. */
let dirTemporal: string;
beforeEach(async () => {
  proyecto = await crearProyecto();
  carpeta = await mkdtemp(path.join(os.tmpdir(), 'novaciel-capa-out-'));
  dirTemporal = await mkdtemp(path.join(os.tmpdir(), 'novaciel-capa-tmp-'));
  renderer = new FakeRenderer();
  procesos = new FakeProcesos();
});
afterEach(async () => {
  await rm(proyecto.raiz, { recursive: true, force: true });
  await rm(carpeta, { recursive: true, force: true });
  await rm(dirTemporal, { recursive: true, force: true });
});

function adaptador(extra: Partial<Parameters<typeof crearCapaTextoRemotion>[0]> = {}, logs: string[] = []) {
  const logger = pino({ level: 'trace' }, new Writable({ write(chunk, _enc, done) { logs.push(String(chunk)); done(); } }));
  return crearCapaTextoRemotion({
    licencia: 'gratuita',
    raizProyecto: proyecto.raiz,
    raizRemotion: proyecto.remotion,
    cacheDir: proyecto.cache,
    logger,
    deps: { renderer, procesos, directorioTemporal: dirTemporal, existeNavegador: () => true, empaquetar: proyecto.opciones.empaquetar },
    ...extra,
  });
}

/** Short bounds so the tests of the cleanup are quick; `margenDeLimpieza(LIMPIEZA_CORTA)` is the most it can add. */
const LIMPIEZA_CORTA = { cierreMs: 200, procesoMs: 100, trabajoMs: 200, temporalesMs: 100 };

async function esperarHasta(condicion: () => Promise<boolean> | boolean, maxMs = 3000): Promise<boolean> {
  const limite = Date.now() + maxMs;
  while (Date.now() < limite) {
    if (await condicion()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return condicion();
}
const opciones = (timeoutMs = 5000) => ({ carpeta, timeoutMs });
const nombresEnCarpeta = async () => (await readdir(carpeta)).sort();

describe('the adapter: what it refuses before doing anything', () => {
  it('with no license declared it refuses with the typed error and starts nothing', async () => {
    await expect(adaptador({ licencia: undefined }).renderizar(entradaDe(propsDe()), opciones())).rejects.toBeInstanceOf(RemotionLicenciaNoConfiguradaError);
    expect(renderer.aperturas).toBe(0);
    expect(proyecto.empaquetados).toBe(0);
    expect(await nombresEnCarpeta()).toEqual([]);
  });

  it('refuses input that is not exactly the template props, or does not match the entry, naming no text', async () => {
    const props = propsDe();
    const malas: unknown[] = [
      null,
      undefined,
      {},
      { ...props, extra: 1 },
      { ...props, fuente: 'Comic Sans' },
      { ...props, modo: 'bloque' },
    ];
    for (const mala of malas) {
      await expect(adaptador().renderizar({ ...entradaDe(props), props: mala }, opciones())).rejects.toMatchObject({ name: 'CapaTextoError', razon: 'entrada_invalida' });
    }
    // The entry disagrees with the props.
    for (const cambio of [{ fotogramas: 99 }, { plantilla: 'barra_inferior' }, { version: 2 }, { fps: 24 }, { ancho: 540 }, { alto: 100 }]) {
      await expect(adaptador().renderizar({ ...entradaDe(props), ...cambio }, opciones())).rejects.toMatchObject({ razon: 'entrada_invalida' });
    }
    for (const t of [0, -1, Number.NaN]) await expect(adaptador().renderizar(entradaDe(props), opciones(t))).rejects.toMatchObject({ razon: 'entrada_invalida' });
    expect(renderer.aperturas).toBe(0);
    expect(proyecto.empaquetados).toBe(0);
  });

  it('refuses when the browser is not where it should be, without calling Remotion or bundling', async () => {
    await expect(adaptador({ deps: { renderer, existeNavegador: () => false, empaquetar: proyecto.opciones.empaquetar } }).renderizar(entradaDe(propsDe()), opciones())).rejects.toMatchObject({
      name: 'RemotionNoDisponibleError',
      razon: 'navegador_ausente',
    });
    expect(renderer.aperturas).toBe(0);
    expect(proyecto.empaquetados).toBe(0);
  });

  it('empty text gives no layer and starts nothing; unsupported glyphs are refused before any rendering', async () => {
    const sinTexto = construirPropsPlantilla({ plantilla: { id: 'barra_inferior', version: 1 }, escena: { orden: 1, texto: '   ', fotogramas: 12 }, fps: 30, colores, ancho: 1080, alto: 1920, medir });
    expect(sinTexto).toBeNull();
    const adapter = adaptador();
    const capa = await renderizarCapaEscena(adapter, { plantilla: 'barra_inferior', version: 1, props: sinTexto, ancho: 1080, alto: 1920, fps: 30, fotogramas: 12 }, opciones());
    expect(capa).toBeNull();
    expect(renderer.aperturas).toBe(0);
    expect(proyecto.empaquetados).toBe(0);
    // Glyphs the bundled font cannot draw never reach the adapter: the props builder refuses first.
    const espia = new FakeCapaTextoAnimado();
    expect(() => construirPropsPlantilla({ plantilla: { id: 'barra_inferior', version: 1 }, escena: { orden: 1, texto: 'Hola 😀', fotogramas: 12 }, fps: 30, colores, ancho: 1080, alto: 1920, medir })).toThrow(UnsupportedGlyphsError);
    expect(espia.llamadas).toEqual([]);
  });
});

describe('the adapter: a render', () => {
  it('renders, normalizes the frame names (with or without padding) and returns the layer', async () => {
    for (const modo of ['sin_padding', 'con_padding'] as const) {
      renderer.modo = modo;
      const props = propsDe(undefined, 12);
      const capa = await adaptador().renderizar(entradaDe(props), opciones());
      expect(capa).toEqual({ carpeta, patron: 'capa-%05d.png', fotogramas: 12, ancho: 1080, alto: 1920 });
      expect(await nombresEnCarpeta()).toEqual(Array.from({ length: 12 }, (_v, i) => nombreFotogramaCapa(i)));
      await borrarCapas(carpeta);
    }
    expect(renderer.composiciones.every((id) => id === idComposicionRemotion('palabra_a_palabra', 1))).toBe(true);
    expect(idComposicionRemotion('titulo_y_palabras', 1)).toBe('titulo-y-palabras-v1');
  });

  it('closes the browser after every render and passes the props only as input props', async () => {
    const props = propsDe();
    await adaptador().renderizar(entradaDe(props), opciones());
    expect(renderer.aperturas).toBe(1);
    expect(renderer.cierres).toBeGreaterThanOrEqual(1);
    expect(renderer.inputProps[0]).toEqual(props);
  });

  it('builds the bundle ONCE for several renders, with the policy in its index.html', async () => {
    const adapter = adaptador();
    for (let i = 0; i < 3; i++) {
      await adapter.renderizar(entradaDe(propsDe()), opciones());
      await borrarCapas(carpeta);
    }
    expect(proyecto.empaquetados).toBe(1);
    const carpetas = (await readdir(proyecto.cache)).filter((n) => n.startsWith('bundle-'));
    expect(carpetas).toHaveLength(1);
    const html = await readFile(path.join(proyecto.cache, carpetas[0]!, 'index.html'), 'utf8');
    expect(html).toContain(POLITICA_CSP);
    expect(html).toContain(META_DNS_PREFETCH);
    expect(META_DNS_PREFETCH).toBe('<meta http-equiv="x-dns-prefetch-control" content="off" />');
  });

  describe('the bundle policy', () => {
    const directivas = new Map(POLITICA_CSP.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)] as const));
    const permitidos = new Set(["'self'", 'blob:', 'data:', "'unsafe-inline'", "'unsafe-eval'", "'none'"]);

    it('is based on default-src, which allows only the bundle origin, data: and blob:', () => {
      expect(POLITICA_CSP.startsWith("default-src 'self' blob: data:")).toBe(true);
      expect(directivas.get('default-src')).toEqual(["'self'", 'blob:', 'data:']);
    });

    it.each(['script-src', 'font-src', 'img-src', 'connect-src', 'worker-src', 'frame-src'])('covers %s without any external host', (nombre) => {
      const valores = directivas.get(nombre);
      expect(valores).toBeDefined();
      expect(valores!.length).toBeGreaterThan(0);
      for (const v of valores!) expect(permitidos.has(v), `${nombre} allows ${v}`).toBe(true);
      expect(valores!.some((v) => v === '*' || /^(https?|wss?|ftp):/.test(v) || v.includes('.'))).toBe(false);
    });

    it('declares worker-src explicitly and frames as none', () => {
      expect(directivas.get('worker-src')).toEqual(["'self'", 'blob:']);
      expect(directivas.get('frame-src')).toEqual(["'none'"]);
    });

    it('never reuses a cached bundle that lacks the DNS prefetch switch or the policy', async () => {
      // A cached folder with the policy but WITHOUT the DNS switch (what an older build left) is replaced.
      const destino = path.join(proyecto.cache, `bundle-${(await claveDeBundle(proyecto.opciones)).slice(0, 20)}`);
      await mkdir(destino, { recursive: true });
      const indice = path.join(destino, 'index.html');
      await writeFile(indice, `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${POLITICA_CSP}" /></head></html>`);
      await obtenerBundle(proyecto.opciones);
      expect(proyecto.empaquetados).toBe(1);
      expect(await readFile(indice, 'utf8')).toContain(META_DNS_PREFETCH);
      expect(FORMATO_BUNDLE).toBeGreaterThanOrEqual(2);
    });
  });

  it('logs ids, the template and counts, never the text', async () => {
    const logs: string[] = [];
    renderer.modo = 'falla';
    await adaptador({}, logs).renderizar(entradaDe(propsDe()), opciones()).catch(() => undefined);
    renderer.modo = 'ok';
    await adaptador({}, logs).renderizar(entradaDe(propsDe()), opciones());
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('')).not.toContain(SECRETO);
    expect(logs.join('')).toContain('palabra_a_palabra');
  });
});

describe('the adapter: failures leave nothing behind', () => {
  it('a render error: typed, the browser closed, the frames removed, the error text not exposed', async () => {
    renderer.modo = 'falla';
    const error = await adaptador().renderizar(entradaDe(propsDe()), opciones()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(CapaTextoError);
    expect(error).toMatchObject({ razon: 'fallo_de_render' });
    expect(JSON.stringify({ m: (error as Error).message, ...(error as object) })).not.toContain(SECRETO);
    expect(renderer.cierres).toBeGreaterThanOrEqual(1);
    expect(await nombresEnCarpeta()).toEqual([]);
  });

  it('a timeout: typed, cancels, closes the browser and removes what was written', async () => {
    renderer.modo = 'cuelga';
    const TIMEOUT = 300;
    const TOLERANCIA_MS = 1000; // scheduler and machine-load slack on top of the documented bound
    const inicio = Date.now();
    await expect(adaptador({ limpieza: LIMPIEZA_CORTA }).renderizar(entradaDe(propsDe()), opciones(TIMEOUT))).rejects.toMatchObject({ name: 'CapaTextoError', razon: 'tiempo_agotado' });
    // Bound: the time limit plus the injected cleanup margin, not a fixed number of seconds.
    expect(Date.now() - inicio).toBeLessThan(TIMEOUT + margenDeLimpieza(LIMPIEZA_CORTA) + TOLERANCIA_MS);
    expect(renderer.cancelado).toBe(true);
    expect(renderer.cierres).toBeGreaterThanOrEqual(1);
    expect(await nombresEnCarpeta()).toEqual([]);
  });

  describe('a browser or a render that does not obey: the call still ends within the time limit plus the cleanup margin', () => {
    const TIMEOUT = 300;
    const COTA = TIMEOUT + margenDeLimpieza(LIMPIEZA_CORTA);
    const conProcesosPropios = () => {
      renderer.alAbrir = async () => void procesos.vivos.push(200, 201);
    };

    it('close() never returns: the browser is killed by its process ids (never the ones that were already running)', async () => {
      renderer.modo = 'cuelga';
      renderer.cierreCuelga = true;
      conProcesosPropios();
      procesos.matar = async (pids) => {
        procesos.muertos.push([...pids]);
        procesos.vivos = procesos.vivos.filter((p) => !pids.includes(p));
        renderer.soltar(); // killing the browser makes the render fail
      };
      const inicio = Date.now();
      await expect(adaptador({ limpieza: LIMPIEZA_CORTA }).renderizar(entradaDe(propsDe()), opciones(TIMEOUT))).rejects.toMatchObject({ name: 'CapaTextoError', razon: 'tiempo_agotado' });
      expect(Date.now() - inicio).toBeLessThan(COTA);
      expect(renderer.cancelado).toBe(true);
      expect(procesos.muertos).toEqual([[200, 201]]);
      expect(procesos.vivos).toEqual([100]);
      expect(await nombresEnCarpeta()).toEqual([]);
    });

    it('the browser closed but its processes are still there: they are killed; if they are gone, nothing is killed', async () => {
      renderer.modo = 'cuelga';
      conProcesosPropios();
      await expect(adaptador({ limpieza: LIMPIEZA_CORTA }).renderizar(entradaDe(propsDe()), opciones(TIMEOUT))).rejects.toMatchObject({ razon: 'tiempo_agotado' });
      expect(procesos.muertos).toEqual([[200, 201]]);

      procesos.muertos.length = 0;
      procesos.vivos = [100];
      renderer.alCerrar = () => void (procesos.vivos = [100]); // a clean close takes its processes with it
      await expect(adaptador({ limpieza: LIMPIEZA_CORTA }).renderizar(entradaDe(propsDe()), opciones(TIMEOUT))).rejects.toMatchObject({ razon: 'tiempo_agotado' });
      expect(procesos.muertos).toEqual([]);
    });

    it('a render that ignores the cancel, the close and the kill is abandoned in time, and its late frames are removed', async () => {
      renderer.modo = 'no_termina';
      renderer.cierreCuelga = true;
      conProcesosPropios();
      const inicio = Date.now();
      await expect(adaptador({ limpieza: LIMPIEZA_CORTA }).renderizar(entradaDe(propsDe()), opciones(TIMEOUT))).rejects.toMatchObject({ name: 'CapaTextoError', razon: 'tiempo_agotado' });
      expect(Date.now() - inicio).toBeLessThan(COTA);
      expect(procesos.muertos).toEqual([[200, 201]]);
      expect(await nombresEnCarpeta()).toEqual([]);

      renderer.terminar(); // it ends at last, after having written one more frame
      expect(await esperarHasta(() => renderer.escritoTardio)).toBe(true);
      expect(await esperarHasta(async () => (await nombresEnCarpeta()).length === 0)).toBe(true);
    });

    it('time is up while the browser is still opening: nothing else starts, and the browser that opens late is closed', async () => {
      renderer.retrasoApertura = 600;
      const inicio = Date.now();
      await expect(adaptador({ limpieza: LIMPIEZA_CORTA }).renderizar(entradaDe(propsDe()), opciones(100))).rejects.toMatchObject({ razon: 'tiempo_agotado' });
      expect(Date.now() - inicio).toBeLessThan(100 + margenDeLimpieza(LIMPIEZA_CORTA));
      expect(await esperarHasta(() => renderer.cierres >= 1)).toBe(true);
      expect(renderer.composiciones).toEqual([]);
      expect(await nombresEnCarpeta()).toEqual([]);
    });

    it("removes only the temporary folders this render created (a browser profile and Remotion's assets folder), never an older or foreign one", async () => {
      await mkdir(path.join(dirTemporal, 'puppeteer_dev_chrome_profile-viejo'));
      await mkdir(path.join(dirTemporal, 'ajena-a-remotion'));
      await writeFile(path.join(dirTemporal, 'puppeteer_dev_chrome_profile-archivo'), 'x');
      renderer.modo = 'cuelga';
      renderer.alAbrir = async () => {
        await mkdir(path.join(dirTemporal, 'puppeteer_dev_chrome_profile-nuevo'));
        await mkdir(path.join(dirTemporal, 'remotion-v4.0.537-assets-nuevo'));
        await writeFile(path.join(dirTemporal, 'remotion-v4.0.537-assets-nuevo', 'dentro.txt'), 'x');
      };
      await expect(adaptador({ limpieza: LIMPIEZA_CORTA }).renderizar(entradaDe(propsDe()), opciones(TIMEOUT))).rejects.toMatchObject({ razon: 'tiempo_agotado' });
      expect((await readdir(dirTemporal)).sort()).toEqual(['ajena-a-remotion', 'puppeteer_dev_chrome_profile-archivo', 'puppeteer_dev_chrome_profile-viejo']);
    });
  });

  it.each([
    [10_000, 12_000],
    [1_000, 7_000],
  ])("Remotion's own page timeout is a safety net: never under the 7000 ms it demands, above our limit (%i ms -> %i ms)", async (limite, interno) => {
    await adaptador().renderizar(entradaDe(propsDe()), opciones(limite));
    expect(renderer.limitesInternos).toEqual([interno]);
  });

  it('a render that fails after the time limit has passed is a timeout, not a render error', async () => {
    renderer.modo = 'falla_pasado_el_limite';
    await expect(adaptador().renderizar(entradaDe(propsDe()), opciones(100))).rejects.toMatchObject({ name: 'CapaTextoError', razon: 'tiempo_agotado' });
    expect(await nombresEnCarpeta()).toEqual([]);
  });

  it('a request outside the bundle (reported as a Content-Security-Policy violation) fails the render and removes the frames', async () => {
    renderer.modo = 'violacion_csp';
    await expect(adaptador().renderizar(entradaDe(propsDe()), opciones())).rejects.toMatchObject({ razon: 'solicitud_externa' });
    expect(await nombresEnCarpeta()).toEqual([]);
    expect(renderer.cierres).toBeGreaterThanOrEqual(1);
  });

  it('refuses a missing frame, a PNG without transparency and a PNG of the wrong size', async () => {
    for (const modo of ['falta_un_fotograma', 'sin_alfa', 'tamano_malo'] as const) {
      renderer.modo = modo;
      await expect(adaptador().renderizar(entradaDe(propsDe()), opciones()), modo).rejects.toMatchObject({ razon: 'salida_incompleta' });
      expect(await nombresEnCarpeta(), modo).toEqual([]);
    }
  });
});

describe('the frames on disk', () => {
  it('reads the PNG header: size, color type, transparency (RGBA, gray+alpha, palette with tRNS) and not-PNG', async () => {
    const rgba = createCanvas(8, 6).toBuffer('image/png');
    expect(leerCabeceraPng(rgba)).toMatchObject({ ancho: 8, alto: 6, tipoDeColor: 6, conAlfa: true });
    const rgb = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#fff' } }).png().toBuffer();
    expect(leerCabeceraPng(rgb)).toMatchObject({ tipoDeColor: 2, conAlfa: false });
    const paleta = await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png({ palette: true }).toBuffer();
    expect(leerCabeceraPng(paleta)).toMatchObject({ tipoDeColor: 3, conAlfa: true });
    expect(leerCabeceraPng(Buffer.from('not a png at all, just text of some length........'))).toBeNull();
    expect(leerCabeceraPng(Buffer.alloc(10))).toBeNull();
  });

  it('normalizarCapas needs every frame from 0 and renames to capa-00000.png...', async () => {
    const png = createCanvas(16, 16).toBuffer('image/png');
    await writeFile(path.join(carpeta, 'capa-1.png'), png);
    await writeFile(path.join(carpeta, 'capa-0.png'), png);
    await writeFile(path.join(carpeta, 'capa-2.png'), png);
    await normalizarCapas(carpeta, { fotogramas: 3, ancho: 16, alto: 16 });
    expect(await nombresEnCarpeta()).toEqual(['capa-00000.png', 'capa-00001.png', 'capa-00002.png']);
    await rm(path.join(carpeta, 'capa-00001.png'));
    await expect(normalizarCapas(carpeta, { fotogramas: 3, ancho: 16, alto: 16 })).rejects.toMatchObject({ razon: 'salida_incompleta' });
  });

  it('where the downloaded browser is expected, per platform', () => {
    expect(rutaNavegadorDescargado('/p', 'win32', 'x64')).toBe(path.join('/p', 'node_modules', '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    expect(rutaNavegadorDescargado('/p', 'linux', 'x64')).toBe(path.join('/p', 'node_modules', '.remotion', 'chrome-headless-shell', 'linux64', 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    expect(rutaNavegadorDescargado('/p', 'linux', 'arm64')).toContain('linux-arm64');
    expect(() => rutaNavegadorDescargado('/p', 'freebsd')).toThrow(RemotionNoDisponibleError);
  });
});

describe('the bundle and its cache key', () => {
  it('the key changes with a source file, a package version and a font, and not with nothing', async () => {
    const base = await claveDeBundle(proyecto.opciones);
    expect(await claveDeBundle(proyecto.opciones)).toBe(base);
    await writeFile(path.join(proyecto.remotion, 'Root.tsx'), 'export const Root = 1;\n');
    const conFuente = await claveDeBundle(proyecto.opciones);
    expect(conFuente).not.toBe(base);
    await writeFile(path.join(proyecto.remotion, 'nuevo.ts'), 'export {};\n');
    expect(await claveDeBundle(proyecto.opciones)).not.toBe(conFuente);
    const antes = await claveDeBundle(proyecto.opciones);
    await writeFile(path.join(proyecto.raiz, 'node_modules', 'remotion', 'package.json'), JSON.stringify({ name: 'remotion', version: '1.0.1' }));
    expect(await claveDeBundle(proyecto.opciones)).not.toBe(antes);
    expect(FORMATO_BUNDLE).toBeGreaterThanOrEqual(1);
  });

  it('a missing package is "paquete_ausente"', async () => {
    await rm(path.join(proyecto.raiz, 'node_modules', 'react-dom'), { recursive: true, force: true });
    await expect(claveDeBundle(proyecto.opciones)).rejects.toMatchObject({ name: 'RemotionNoDisponibleError', razon: 'paquete_ausente' });
  });

  it('a build that did not take the policy is refused, and a failed build is not remembered', async () => {
    const roto: OpcionesBundle = {
      ...proyecto.opciones,
      cacheDir: path.join(proyecto.raiz, 'cache-roto'),
      empaquetar: async ({ outDir }) => {
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, 'index.html'), '<html>no head tag here</html>');
        return outDir;
      },
    };
    await expect(obtenerBundle(roto)).rejects.toMatchObject({ razon: 'fallo_de_bundle' });
    expect(await readdir(roto.cacheDir)).toEqual([]); // nothing half-built is left
    // The same project builds fine afterwards: the failure was not cached.
    const bueno = { ...proyecto.opciones, cacheDir: roto.cacheDir };
    const carpetaBundle = await obtenerBundle(bueno);
    expect(await readFile(path.join(carpetaBundle, 'index.html'), 'utf8')).toContain('Content-Security-Policy');
  });

  it('copies the two bundled fonts next to the build so staticFile() finds them', async () => {
    let publicDir = '';
    const opts: OpcionesBundle = {
      ...proyecto.opciones,
      cacheDir: path.join(proyecto.raiz, 'cache-fuentes'),
      empaquetar: async (o) => {
        publicDir = o.publicDir;
        expect((await readdir(path.join(o.publicDir, 'fonts'))).sort()).toEqual(['inter-latin-400-normal.woff2', 'inter-latin-700-normal.woff2']);
        return proyecto.opciones.empaquetar!(o);
      },
    };
    await obtenerBundle(opts);
    expect(publicDir).not.toBe('');
  });
});

describe('the type of the props', () => {
  it('the server props fit the type the Remotion project declares', () => {
    const props: PropsPlantilla = propsDe();
    const paraRemotion: PropsCapa = props;
    expect(paraRemotion.lineas.length).toBeGreaterThan(0);
  });
});
