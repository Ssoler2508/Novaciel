import { z } from 'zod';
import type { ColoresSlide } from './colors.js';
import { PlantillaInvalidaError } from './errors.js';
import { assertGlifosSoportados, FUENTE_POR_DEFECTO } from './fonts.js';
import { distribuirPalabras } from './lineasPalabras.js';
import { getPlantilla } from './plantillas.js';
import { calcularTiemposPalabras, palabrasDe, REGLAS_TIEMPOS } from './tiemposPalabras.js';
import type { Medir } from './textLayout.js';

// The props of the animated text templates (Step 7c). PURE: from a scene, the colors and the canvas it
// builds the object that a Remotion composition renders, validated with a STRICT schema per template.
//
// CLIENT TEXT appears in exactly ONE place: `lineas[i].palabras[j].texto`. Every other string in the props
// is one of a fixed set (the template id, `modo`, `posicion`, the bundled font, `#rrggbb` colors), so the
// text reaches the composition only as a React text child, never as markup, a URL or a command.

/** Scale of the 7a size range for a title card (a house value, VERIFICAR). */
const ESCALA_TITULO = 1.25;
const MAX_FOTOGRAMAS = 30 * 60 * 3;

const hex = z.string().regex(/^#[0-9a-f]{6}$/);
const entero = (min: number, max: number) => z.number().int().min(min).max(max);

const palabraSchema = z
  .object({
    /** THE declared text field. One whitespace-free word of the scene's on-screen text. */
    texto: z.string().min(1).max(400).regex(/^\S+$/u),
    inicioMs: entero(0, 10_800_000),
    finMs: entero(0, 10_800_000),
    inicioFotograma: entero(0, MAX_FOTOGRAMAS),
    finFotograma: entero(0, MAX_FOTOGRAMAS),
  })
  .strict();

const baseShape = {
  version: entero(1, 1000),
  ancho: entero(64, 4096),
  alto: entero(64, 8192),
  fps: entero(1, 120),
  fotogramas: entero(1, MAX_FOTOGRAMAS),
  /** Only the bundled font: nothing is fetched while rendering. */
  fuente: z.literal(FUENTE_POR_DEFECTO),
  colores: z.object({ texto: hex, scrim: hex, alfa: z.number().min(0).max(1) }).strict(),
  scrim: z.object({ y: z.number().min(0), alto: z.number().min(0) }).strict(),
  tamano: z.number().positive().max(512),
  interlineadoPx: z.number().positive().max(1024),
  bloqueArriba: z.number(),
  lineas: z.array(z.object({ palabras: z.array(palabraSchema).min(1).max(200) }).strict()).min(1).max(8),
};

/** Checks that cross fields: times inside the scene, in order, and frames consistent with them. */
function coherente(p: { fotogramas: number; lineas: { palabras: { inicioMs: number; finMs: number; inicioFotograma: number; finFotograma: number }[] }[] }, ctx: z.RefinementCtx): void {
  let anterior = -1;
  for (const [i, linea] of p.lineas.entries()) {
    for (const [j, w] of linea.palabras.entries()) {
      const mal = w.finMs < w.inicioMs || w.finFotograma < w.inicioFotograma || w.finFotograma > p.fotogramas || w.inicioFotograma >= p.fotogramas || w.inicioFotograma < anterior;
      if (mal) ctx.addIssue({ code: 'custom', path: ['lineas', i, 'palabras', j], message: 'inconsistent times' });
      anterior = w.inicioFotograma;
    }
  }
}

export const esquemaPropsPlantilla = z.discriminatedUnion('plantilla', [
  z.object({ ...baseShape, plantilla: z.literal('barra_inferior'), modo: z.literal('bloque'), posicion: z.literal('abajo') }).strict().superRefine(coherente),
  z.object({ ...baseShape, plantilla: z.literal('palabra_a_palabra'), modo: z.literal('palabras'), posicion: z.literal('abajo') }).strict().superRefine(coherente),
  z
    .object({
      ...baseShape,
      plantilla: z.literal('titulo_y_palabras'),
      modo: z.enum(['titulo', 'palabras']),
      posicion: z.enum(['centro', 'abajo']),
    })
    .strict()
    .superRefine(coherente)
    .superRefine((p, ctx) => {
      // The title card is centered; the word-by-word scenes sit at the bottom.
      if ((p.modo === 'titulo') !== (p.posicion === 'centro')) ctx.addIssue({ code: 'custom', path: ['posicion'], message: 'mode and position do not match' });
    }),
]);

export type PropsPlantilla = z.infer<typeof esquemaPropsPlantilla>;

export interface EntradaPropsPlantilla {
  plantilla: { id: string; version: number };
  escena: {
    /** Scene number, from 1. Scene 1 is the hook. */
    orden: number;
    /** The scene's on-screen text. */
    texto: string;
    /** Exact frames of the scene in the 7b timeline. */
    fotogramas: number;
  };
  fps: number;
  /** From elegirColores(kitVisual): the 7a contrast rule. */
  colores: ColoresSlide;
  ancho: number;
  alto: number;
  /** Width of a text at a size; the renderer passes the real canvas, tests a fake. */
  medir: Medir;
}

const aFotograma = (ms: number, fps: number) => Math.round((ms * fps) / 1000);

/**
 * The validated props of a template for one scene, or null when the scene has no text (no layer is
 * drawn). Throws PlantillaInvalidaError (unknown template, bad input, words not matching, schema
 * failure with the NAMES of the fields), UnsupportedGlyphsError (checked FIRST), TextDoesNotFitError,
 * TiemposInvalidosError or InvalidSizeError. Never carries the text.
 */
export function construirPropsPlantilla(entrada: EntradaPropsPlantilla): PropsPlantilla | null {
  const plantilla = getPlantilla(entrada.plantilla.id, entrada.plantilla.version);
  if (!plantilla) throw new PlantillaInvalidaError('plantilla_desconocida');
  const { escena, fps, ancho, alto } = entrada;
  const malo = [
    !Number.isInteger(escena.orden) || escena.orden < 1 ? 'escena.orden' : null,
    !Number.isInteger(escena.fotogramas) || escena.fotogramas < 1 || escena.fotogramas > MAX_FOTOGRAMAS ? 'escena.fotogramas' : null,
    !Number.isInteger(fps) || fps < 1 || fps > 120 ? 'fps' : null,
    !Number.isInteger(ancho) || ancho < 64 || ancho > 4096 ? 'ancho' : null,
    !Number.isInteger(alto) || alto < 64 || alto > 8192 ? 'alto' : null,
    typeof escena.texto !== 'string' ? 'escena.texto' : null,
  ].filter((c): c is string => c !== null);
  if (malo.length > 0) throw new PlantillaInvalidaError('entrada_invalida', malo);

  const texto = escena.texto.normalize('NFC').trim();
  if (texto === '') return null;
  assertGlifosSoportados(texto); // before anything else is built

  const duracionMs = Math.round((escena.fotogramas * 1000) / fps);
  const esTitulo = plantilla.id === 'titulo_y_palabras' && escena.orden === 1;
  const modo = plantilla.id === 'barra_inferior' ? 'bloque' : esTitulo ? 'titulo' : 'palabras';
  const distribucion = distribuirPalabras({
    texto,
    ancho,
    alto,
    formato: 'reel',
    medir: entrada.medir,
    escalaTamano: esTitulo ? ESCALA_TITULO : 1,
    posicion: esTitulo ? 'centro' : 'abajo',
  });

  // When each word appears: together at the lead-in (block and title card), or at its own time.
  const tiempos =
    modo === 'palabras'
      ? calcularTiemposPalabras(texto, duracionMs)
      : (() => {
          const inicio = Math.min(REGLAS_TIEMPOS.entradaMs, duracionMs - 1);
          return palabrasDe(texto).map((palabra) => ({ palabra, inicioMs: inicio, finMs: duracionMs }));
        })();

  let anterior = 0;
  const lineas = distribucion.lineas.map((linea) => ({
    palabras: linea.map(({ indice, texto: palabra }) => {
      const t = tiempos[indice]!;
      const inicioFotograma = Math.max(anterior, Math.min(entrada.escena.fotogramas - 1, aFotograma(t.inicioMs, fps)));
      anterior = inicioFotograma;
      const finFotograma = t.finMs >= duracionMs ? escena.fotogramas : Math.max(inicioFotograma, Math.min(escena.fotogramas, aFotograma(t.finMs, fps)));
      return { texto: palabra, inicioMs: t.inicioMs, finMs: t.finMs, inicioFotograma, finFotograma };
    }),
  }));

  const candidato = {
    plantilla: plantilla.id,
    version: plantilla.version,
    ancho,
    alto,
    fps,
    fotogramas: escena.fotogramas,
    fuente: FUENTE_POR_DEFECTO,
    colores: { texto: entrada.colores.texto, scrim: entrada.colores.scrim, alfa: entrada.colores.alfa },
    scrim: { y: distribucion.banda.y, alto: distribucion.banda.alto },
    tamano: distribucion.tamano,
    interlineadoPx: distribucion.interlineadoPx,
    bloqueArriba: distribucion.bloqueArriba,
    posicion: distribucion.posicion,
    modo,
    lineas,
  };
  const resultado = esquemaPropsPlantilla.safeParse(candidato);
  if (!resultado.success) {
    // Names of the failing fields only: a value could be client text.
    throw new PlantillaInvalidaError('props_invalidas', [...new Set(resultado.error.issues.map((i) => i.path.filter((p) => typeof p === 'string').join('.') || 'props'))]);
  }
  return resultado.data;
}
