import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { CapaTextoError } from './errors.js';

// The port behind which the animated text layer is drawn (Step 7c). The Remotion renderer (checkpoint C)
// is ONE adapter of it, so it can be replaced (FFmpeg with canvas, Revideo) without touching the reel
// pipeline. The port knows nothing about Remotion.
//
// A layer is a PNG SEQUENCE with transparency, one file per frame, `capa-00000.png`, `capa-00001.png`...
// in a folder the CALLER owns and removes (as the 7b temp folder). The 7b FFmpeg step overlays it. Client
// text reaches an adapter only inside `props` (validated, text fields only) and never in a command line.

export const PATRON_CAPA = 'capa-%05d.png';
export const nombreFotogramaCapa = (indice: number): string => `capa-${String(indice).padStart(5, '0')}.png`;

export interface EntradaCapa {
  /** Template id and version from the registry. */
  plantilla: string;
  version: number;
  /** The validated props of the template (checkpoint B): the only place where client text appears. */
  props: unknown;
  ancho: number;
  alto: number;
  fps: number;
  /** Exact number of frames: the frames of the scene in the 7b timeline. */
  fotogramas: number;
}

export interface OpcionesCapa {
  /** An empty folder (created by the caller) where the frames are written. */
  carpeta: string;
  /** Time limit of the whole layer, in ms. */
  timeoutMs: number;
}

export interface CapaRenderizada {
  carpeta: string;
  /** The FFmpeg pattern file name inside `carpeta` (`capa-%05d.png`). */
  patron: string;
  fotogramas: number;
  ancho: number;
  alto: number;
}

export interface CapaTextoAnimado {
  /**
   * Draws the layer. Throws CapaTextoError (render failed or timed out),
   * RemotionNoDisponibleError (the engine or its browser is missing) or
   * RemotionLicenciaNoConfiguradaError (the adapter checks the license first).
   */
  renderizar(entrada: EntradaCapa, opciones: OpcionesCapa): Promise<CapaRenderizada>;
}

/**
 * The layer of one scene, or null when the scene has no text (`props` is null: B's builder returns null for an
 * empty text). Nothing is called and nothing is started for a scene without text: empty text gives no layer.
 */
export async function renderizarCapaEscena(
  adaptador: CapaTextoAnimado,
  entrada: Omit<EntradaCapa, 'props'> & { props: unknown },
  opciones: OpcionesCapa,
): Promise<CapaRenderizada | null> {
  if (entrada.props === null || entrada.props === undefined) return null;
  return adaptador.renderizar(entrada, opciones);
}

/**
 * Test adapter: writes fully transparent PNGs of the requested size, one per frame (no engine, no
 * browser, no network). Enough to test the pipeline around the port; the real pixels come from the
 * Remotion adapter of checkpoint C.
 */
export class FakeCapaTextoAnimado implements CapaTextoAnimado {
  readonly llamadas: EntradaCapa[] = [];
  /** Makes the next call fail, to test the failure policy. */
  fallarCon: CapaTextoError | Error | null = null;

  async renderizar(entrada: EntradaCapa, opciones: OpcionesCapa): Promise<CapaRenderizada> {
    this.llamadas.push(entrada);
    if (this.fallarCon) throw this.fallarCon;
    if (!Number.isInteger(entrada.fotogramas) || entrada.fotogramas < 1) throw new CapaTextoError('entrada_invalida');
    await mkdir(opciones.carpeta, { recursive: true });
    // One transparent PNG at the real size, written for every frame (it is a fake).
    const canvas = createCanvas(entrada.ancho, entrada.alto);
    const png = canvas.toBuffer('image/png');
    for (let i = 0; i < entrada.fotogramas; i++) await writeFile(path.join(opciones.carpeta, nombreFotogramaCapa(i)), png);
    return { carpeta: opciones.carpeta, patron: PATRON_CAPA, fotogramas: entrada.fotogramas, ancho: entrada.ancho, alto: entrada.alto };
  }
}
