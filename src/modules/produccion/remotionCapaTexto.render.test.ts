import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeRemotion, navegadorDeLasPruebas } from '../../../tests/utils/remotion.js';
import { nombreFotogramaCapa } from './capaTexto.js';
import { elegirColores } from './colors.js';
import { RemotionLicenciaNoConfiguradaError, UnsupportedGlyphsError } from './errors.js';
import { crearMedidor } from './medidor.js';
import { PLANTILLAS } from './plantillas.js';
import { construirPropsPlantilla, type PropsPlantilla } from './propsPlantilla.js';
import { POLITICA_CSP } from './remotionBundle.js';
import { crearCapaTextoRemotion, raizDelProyecto, type OpcionesCapaTextoRemotion } from './remotionCapaTexto.js';

// REAL Remotion, REAL Chrome Headless Shell (the one `npm run remotion:browser` downloaded). Slow: the first
// test builds the bundle (about 30 s, cached on disk afterwards) and each scene takes seconds, so the file is
// named *.render.test.ts and `npm run test:fast` skips it. Measured idle on this laptop: the three templates of
// 150 frames take about 31 s together, word by word about 11 s, the two together-appearing ones about 19 s, the
// timeout test about 8 s; every test has a limit of 120 s.

const RAIZ = raizDelProyecto();
const medir = crearMedidor();
const COLORES = { texto: '#ffffff', scrim: '#000000', alfa: 0.8, origen: 'respaldo', contraste: 21 } as const;
const TEXTO = 'Cada mañana tostamos el café de origen colombiano en nuestra casa';
const FPS = 30;
const FOTOGRAMAS = 150;

function props(plantilla: string, orden = 2, texto = TEXTO, fotogramas = FOTOGRAMAS): PropsPlantilla {
  return construirPropsPlantilla({ plantilla: { id: plantilla, version: 1 }, escena: { orden, texto, fotogramas }, fps: FPS, colores: COLORES, ancho: 1080, alto: 1920, medir })!;
}
const entrada = (p: PropsPlantilla) => ({ plantilla: p.plantilla, version: p.version, props: p, ancho: p.ancho, alto: p.alto, fps: p.fps, fotogramas: p.fotogramas });
const adaptador = (extra: Partial<OpcionesCapaTextoRemotion> = {}) => crearCapaTextoRemotion({ licencia: 'gratuita', navegador: navegadorDeLasPruebas(), ...extra });

const carpetas: string[] = [];
async function carpetaNueva(): Promise<string> {
  const c = await mkdtemp(path.join(os.tmpdir(), 'novaciel-capa-render-'));
  carpetas.push(c);
  return c;
}
afterAll(async () => {
  for (const c of carpetas) await rm(c, { recursive: true, force: true });
});

/** Raw RGBA pixels of frame `n`. */
async function pixeles(carpeta: string, n: number) {
  const { data, info } = await sharp(path.join(carpeta, nombreFotogramaCapa(n))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, ancho: info.width, alto: info.height };
}
const totalmenteTransparente = (d: Buffer) => {
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
  return true;
};
/** Pixels that look like the WHITE text (opaque and near white) inside a box. */
function pixelesDeTexto(p: { data: Buffer; ancho: number }, caja: { x0: number; x1: number; y0: number; y1: number }): number {
  let cuenta = 0;
  for (let y = Math.max(0, Math.floor(caja.y0)); y < Math.floor(caja.y1); y++) {
    for (let x = Math.max(0, Math.floor(caja.x0)); x < Math.floor(caja.x1); x++) {
      const i = (y * p.ancho + x) * 4;
      if (p.data[i + 3]! >= 200 && p.data[i]! >= 200 && p.data[i + 1]! >= 200 && p.data[i + 2]! >= 200) cuenta++;
    }
  }
  return cuenta;
}

/** The box of every word, from the props and the same measure the layout used (a few pixels of margin kept off). */
function cajasDePalabras(p: PropsPlantilla) {
  const ctx = createCanvas(16, 16).getContext('2d');
  const ancho = (t: string) => {
    ctx.font = `700 ${p.tamano}px "Inter"`;
    return ctx.measureText(t).width;
  };
  return p.lineas.flatMap((linea, i) => {
    const textos = linea.palabras.map((w) => w.texto);
    const inicioLinea = (p.ancho - ancho(textos.join(' '))) / 2;
    return linea.palabras.map((w, j) => {
      const x0 = inicioLinea + (j === 0 ? 0 : ancho(`${textos.slice(0, j).join(' ')} `));
      const x1 = inicioLinea + ancho(textos.slice(0, j + 1).join(' '));
      const y0 = p.bloqueArriba + i * p.interlineadoPx;
      return { w, caja: { x0: x0 + 3, x1: x1 - 3, y0: y0 + 2, y1: y0 + p.interlineadoPx - 2 } };
    });
  });
}

describeRemotion('renderCapaTexto with the real Remotion', () => {
  // The first call builds the bundle (about 30 s); the others reuse it. Then 150 frames take about 8 to 13 s.
  it('each template renders the right number of frames at the right size, with transparency', async () => {
    for (const t of PLANTILLAS) {
      const carpeta = await carpetaNueva();
      const p = props(t.id, 1);
      const capa = await adaptador().renderizar(entrada(p), { carpeta, timeoutMs: 110_000 });
      expect(capa).toEqual({ carpeta, patron: 'capa-%05d.png', fotogramas: FOTOGRAMAS, ancho: 1080, alto: 1920 });
      expect(await readdir(carpeta)).toHaveLength(FOTOGRAMAS);
      const primera = await pixeles(carpeta, 0);
      expect([primera.ancho, primera.alto]).toEqual([1080, 1920]);
      expect(totalmenteTransparente(primera.data), `${t.id}: frame 0 is fully transparent`).toBe(true);
      const ultima = await pixeles(carpeta, FOTOGRAMAS - 1);
      expect(totalmenteTransparente(ultima.data), `${t.id}: the last frame has the band and the text`).toBe(false);
      // The text is really drawn: white pixels exist somewhere inside the text block of the last frame.
      const bloque = { x0: 0, x1: 1080, y0: p.bloqueArriba, y1: p.bloqueArriba + p.lineas.length * p.interlineadoPx };
      expect(pixelesDeTexto(ultima, bloque), t.id).toBeGreaterThan(500);
      // Nothing outside the band is drawn (the layer is only the band and the text).
      const fuera = { x0: 0, x1: 1080, y0: 0, y1: Math.max(0, p.scrim.y - 4) };
      expect(totalmenteTransparente(ultima.data.subarray(0, fuera.y1 * 1080 * 4)), `${t.id}: nothing above the band`).toBe(true);
    }
  }, 120_000);

  it('a still frame at a word start shows that word and not the next one (word by word)', async () => {
    const carpeta = await carpetaNueva();
    const p = props('palabra_a_palabra');
    await adaptador().renderizar(entrada(p), { carpeta, timeoutMs: 110_000 });
    const cajas = cajasDePalabras(p);
    expect(cajas.length).toBeGreaterThan(6);
    for (const k of [0, 2, 5]) {
      const { w, caja } = cajas[k]!;
      const siguiente = cajas[k + 1]!;
      // One frame before its start the word is not there; after the 4-frame fade it is, and the next one still is not.
      const antes = await pixeles(carpeta, Math.max(0, w.inicioFotograma - 1));
      const despues = await pixeles(carpeta, w.inicioFotograma + 5);
      expect(pixelesDeTexto(antes, caja), `word ${k} before its start`).toBe(0);
      expect(pixelesDeTexto(despues, caja), `word ${k} at its start`).toBeGreaterThan(40);
      expect(pixelesDeTexto(despues, siguiente.caja), `word ${k + 1} not yet`).toBe(0);
    }
    // At the end all the words are on screen.
    const final = await pixeles(carpeta, FOTOGRAMAS - 1);
    for (const { caja } of cajas) expect(pixelesDeTexto(final, caja)).toBeGreaterThan(40);
  }, 120_000);

  it('the title card and the block appear all together, not word by word', async () => {
    for (const [id, orden] of [['titulo_y_palabras', 1], ['barra_inferior', 2]] as const) {
      const carpeta = await carpetaNueva();
      const p = props(id, orden);
      await adaptador().renderizar(entrada(p), { carpeta, timeoutMs: 110_000 });
      const cajas = cajasDePalabras(p);
      const f = p.lineas[0]!.palabras[0]!.inicioFotograma + 25; // the entrance (8 to 14 frames) is done
      const marcado = await pixeles(carpeta, f);
      for (const { caja } of cajas) expect(pixelesDeTexto(marcado, caja), id).toBeGreaterThan(20);
    }
  }, 120_000);

  it('a scene with a word-by-word text in 12 frames still renders (very short scene)', async () => {
    const carpeta = await carpetaNueva();
    const p = props('palabra_a_palabra', 2, 'Hola mundo', 12);
    await adaptador().renderizar(entrada(p), { carpeta, timeoutMs: 110_000 });
    expect(await readdir(carpeta)).toHaveLength(12);
  }, 120_000);

  it('unsupported glyphs are refused before any rendering: no browser starts', async () => {
    const antes = procesosDeNavegador();
    expect(() => construirPropsPlantilla({ plantilla: { id: 'palabra_a_palabra', version: 1 }, escena: { orden: 2, texto: 'Hola 😀', fotogramas: 30 }, fps: FPS, colores: COLORES, ancho: 1080, alto: 1920, medir })).toThrow(UnsupportedGlyphsError);
    expect(procesosDeNavegador()).toBe(antes);
  });

  it('with no license declared it refuses with the typed error and starts no browser', async () => {
    const carpeta = await carpetaNueva();
    const antes = procesosDeNavegador();
    await expect(adaptador({ licencia: undefined }).renderizar(entrada(props('barra_inferior')), { carpeta, timeoutMs: 10_000 })).rejects.toBeInstanceOf(RemotionLicenciaNoConfiguradaError);
    expect(procesosDeNavegador()).toBe(antes);
    expect(await readdir(carpeta)).toEqual([]);
  });

  it('a timeout gives the typed error and leaves nothing behind: no frames, no browser, no temporary folders', async () => {
    const carpeta = await carpetaNueva();
    await adaptador().renderizar(entrada(props('barra_inferior', 2, 'Hola', 12)), { carpeta: await carpetaNueva(), timeoutMs: 110_000 }); // warms the bundle
    const antesProcesos = procesosDeNavegador();
    const antesTmp = temporalesDeRender();
    await expect(adaptador().renderizar(entrada(props('palabra_a_palabra', 2, TEXTO, 300)), { carpeta, timeoutMs: 1500 })).rejects.toMatchObject({ name: 'CapaTextoError', razon: 'tiempo_agotado' });
    expect(await readdir(carpeta)).toEqual([]);
    await new Promise((r) => setTimeout(r, 2000)); // the browser takes a moment to exit
    expect(procesosDeNavegador()).toBe(antesProcesos);
    expect(temporalesDeRender()).toEqual(antesTmp);
  }, 120_000);
});

// ---- NETWORK OFF ---------------------------------------------------------------------------------

/** The "outside world": a reachable local server on the fixed port the fixture composition tries to reach. */
function servidorDeFuera() {
  const peticiones: string[] = [];
  const servidor = http.createServer((req, res) => {
    peticiones.push(String(req.url));
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('x');
  });
  return {
    peticiones,
    iniciar: () =>
      new Promise<void>((resolve, reject) => {
        servidor.once('error', reject);
        servidor.listen(39517, '127.0.0.1', resolve);
      }),
    cerrar: () => new Promise<void>((resolve) => servidor.close(() => resolve())),
  };
}

describeRemotion('the page cannot reach the network (a Content-Security-Policy in the bundle)', () => {
  const fuera = servidorDeFuera();
  const RAIZ_FIXTURE = path.join(RAIZ, 'tests', 'fixtures', 'remotion-red');
  beforeAll(async () => {
    await fuera.iniciar();
  });
  afterAll(async () => {
    await fuera.cerrar();
  });

  it('a composition that tries to reach a reachable server never gets there, and the render fails with "solicitud_externa"', async () => {
    const carpeta = await carpetaNueva();
    fuera.peticiones.length = 0;
    const p = props('barra_inferior', 2, 'Hola', 10);
    await expect(
      adaptador({ raizRemotion: RAIZ_FIXTURE, cacheDir: path.join(RAIZ, '.data', 'remotion-test-red') }).renderizar(entrada(p), { carpeta, timeoutMs: 110_000 }),
    ).rejects.toMatchObject({ name: 'CapaTextoError', razon: 'solicitud_externa' });
    expect(fuera.peticiones, 'the outside server received nothing').toEqual([]);
    expect(await readdir(carpeta)).toEqual([]);
  }, 120_000);

  it('CONTROL: the same composition WITHOUT the policy does reach the server (so the test above can see a leak)', async () => {
    // Built straight with Remotion, with no policy: proof that the fixture really tries and that the server is reachable.
    const { bundle } = await import('@remotion/bundler');
    const { openBrowser, renderFrames, selectComposition } = await import('@remotion/renderer');
    const salida = await mkdtemp(path.join(os.tmpdir(), 'novaciel-red-control-'));
    carpetas.push(salida);
    const serveUrl = await bundle({ entryPoint: path.join(RAIZ_FIXTURE, 'index.tsx'), rootDir: RAIZ, outDir: path.join(salida, 'bundle') });
    const html = await readFile(path.join(serveUrl, 'index.html'), 'utf8');
    expect(html).not.toContain('Content-Security-Policy');
    const p = props('barra_inferior', 2, 'Hola', 10);
    const navegador = await openBrowser('chrome', { browserExecutable: navegadorDeLasPruebas(), logLevel: 'error' });
    fuera.peticiones.length = 0;
    try {
      const inputProps = p as unknown as Record<string, unknown>;
      const composition = await selectComposition({ serveUrl, id: 'barra-inferior-v1', inputProps, puppeteerInstance: navegador });
      const frames = path.join(salida, 'frames');
      await mkdir(frames, { recursive: true });
      await renderFrames({ serveUrl, composition, inputProps, outputDir: frames, imageFormat: 'png', puppeteerInstance: navegador, concurrency: 1, onStart: () => undefined, onFrameUpdate: () => undefined });
    } finally {
      await navegador.close({ silent: true });
    }
    expect(fuera.peticiones.length).toBeGreaterThan(0);
  }, 120_000);

  it('the policy is the one written in the bundle, and every normal render makes only local requests', async () => {
    expect(POLITICA_CSP).toContain("connect-src 'self'");
    expect(POLITICA_CSP).toContain("img-src 'self' data: blob:");
    // A normal render of the real templates ends without a violation (the adapter would have thrown) and without
    // any request leaving: the outside server stays untouched.
    fuera.peticiones.length = 0;
    const carpeta = await carpetaNueva();
    await adaptador().renderizar(entrada(props('titulo_y_palabras', 1, TEXTO, 60)), { carpeta, timeoutMs: 110_000 });
    expect(fuera.peticiones).toEqual([]);
  }, 120_000);
});

// ---- helpers: processes and temporary folders ------------------------------------------------------

/** How many Chrome Headless Shell processes are running now. */
function procesosDeNavegador(): number {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome-headless-shell.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return (r.stdout ?? '').split(/\r?\n/).filter((l) => l.toLowerCase().includes('chrome-headless-shell')).length;
  }
  const r = spawnSync('pgrep', ['-fc', 'chrome-headless-shell'], { encoding: 'utf8' });
  return Number((r.stdout ?? '0').trim()) || 0;
}

/** Temporary folders that Remotion or its browser create in the OS temp directory. */
function temporalesDeRender(): string[] {
  return spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require('fs').readdirSync(require('os').tmpdir()).filter(n => /^(puppeteer|remotion|\\.org\\.chromium|chromium)/i.test(n)).sort()))`], { encoding: 'utf8' }).stdout
    .trim()
    .split('\n')
    .flatMap((l) => (l ? (JSON.parse(l) as string[]) : []));
}
