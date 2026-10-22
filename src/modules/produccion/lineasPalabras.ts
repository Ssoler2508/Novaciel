import type { Formato } from '../planificador/types.js';
import { PlantillaInvalidaError } from './errors.js';
import { ALTO_MAXIMO_DEL_TEXTO, ANCHO_REFERENCIA, MAX_LINEAS, posicionDelBloque } from './bloqueTexto.js';
import { zonaSegura } from './safeArea.js';
import { INTERLINEADO, layoutText, TAMANO_MAX, TAMANO_MIN, type Medir } from './textLayout.js';
import { palabrasDe } from './tiemposPalabras.js';

// Line breaking for the animated text (Step 7c). The WHOLE text is laid out once, with the 7a layout and
// the safe zone of the reel, so every word has its place from the first frame: words appear in place
// (opacity), nothing reflows and nothing flickers. Pure: the width of a text is measured by a function
// passed in (the renderer gives it the real canvas; tests give it a fake). The text is never cut.

export interface EntradaLineas {
  texto: string;
  ancho: number;
  alto: number;
  formato?: Formato;
  medir: Medir;
  /** Multiplier of the 7a size range (a title card uses a larger one). */
  escalaTamano?: number;
  /** 'abajo' = bottom of the safe zone like the static overlay; 'centro' = centered in it. */
  posicion?: 'abajo' | 'centro';
}

export interface PalabraEnLinea {
  /** Position of the word in the text, from 0. */
  indice: number;
  texto: string;
}

export interface LineasDistribuidas {
  tamano: number;
  interlineadoPx: number;
  altoBloque: number;
  lineas: PalabraEnLinea[][];
  posicion: 'abajo' | 'centro';
  /** Top of the text block and of the translucent band behind it, in pixels. */
  bloqueArriba: number;
  banda: { y: number; alto: number };
}

/**
 * Throws TextDoesNotFitError (as in 7a) when the text fits at no size, InvalidSizeError for a bad canvas,
 * and PlantillaInvalidaError('palabras_no_coinciden') if the lines do not hold exactly the words of the text.
 */
export function distribuirPalabras(entrada: EntradaLineas): LineasDistribuidas {
  const formato = entrada.formato ?? 'reel';
  const posicion = entrada.posicion ?? 'abajo';
  const texto = entrada.texto.normalize('NFC');
  const k = entrada.ancho / ANCHO_REFERENCIA;
  const escala = entrada.escalaTamano ?? 1;
  const zona = zonaSegura(entrada.ancho, entrada.alto, formato);
  const layout = layoutText({
    texto,
    maxAncho: zona.ancho,
    maxAlto: zona.alto * ALTO_MAXIMO_DEL_TEXTO,
    medir: entrada.medir,
    tamanoMax: TAMANO_MAX * k * escala,
    tamanoMin: TAMANO_MIN * k,
    paso: 2 * k,
    interlineado: INTERLINEADO,
    maxLineas: MAX_LINEAS,
  });

  // The lines are made of the same whitespace-separated words, in the same order.
  const esperadas = palabrasDe(texto);
  let indice = 0;
  const lineas = layout.lineas.map((linea) => palabrasDe(linea).map((palabra): PalabraEnLinea => ({ indice: indice++, texto: palabra })));
  const planas = lineas.flat();
  if (planas.length !== esperadas.length || planas.some((p, i) => p.texto !== esperadas[i])) {
    throw new PlantillaInvalidaError('palabras_no_coinciden');
  }

  // A centered block is the same geometry with the safe zone shrunk around the block.
  const zonaDelBloque = posicion === 'abajo' ? zona : { y: zona.y + (zona.alto - layout.altoBloque) / 2, alto: layout.altoBloque };
  const { bloqueArriba, bandaArriba, bandaAbajo } = posicionDelBloque(zonaDelBloque, entrada.alto, layout);
  return {
    tamano: layout.tamano,
    interlineadoPx: layout.interlineadoPx,
    altoBloque: layout.altoBloque,
    lineas,
    posicion,
    bloqueArriba,
    banda: { y: bandaArriba, alto: bandaAbajo - bandaArriba },
  };
}
