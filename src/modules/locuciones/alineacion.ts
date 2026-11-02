import { palabrasDe, type TiempoPalabra } from '../produccion/tiemposPalabras.js';
import { AlineacionInvalidaError } from './errors.js';

// From the provider's character alignment to word times (Step 7d). PURE.
//
// The provider returns, for the text it was sent, one entry per character with a start and an end time.
// The result has the shape of 7c's calcularTiemposPalabras ({ palabra, inicioMs, finMs }), so the
// subtitle component takes either:
//   - the words are those of the text (NFC, split on whitespace, punctuation attached);
//   - a word starts when its first character starts and ends where the next word starts; the LAST word
//     holds until the end of the scene;
//   - accents count as ONE character: an NFD alignment ("e" + combining mark) gives the same result as
//     an NFC one;
//   - ONE character missing from the alignment is interpolated (it takes the time of its neighbour); a
//     word with no timed character, or any other mismatch with the text, is refused.

/** The alignment in whole milliseconds from the start of the audio. */
export interface AlineacionCaracteres {
  caracteres: readonly string[];
  inicioMs: readonly number[];
  finMs: readonly number[];
}

/** The alignment as the provider sends it (seconds as decimals). */
export interface AlineacionEnSegundos {
  characters: readonly string[];
  character_start_times_seconds: readonly number[];
  character_end_times_seconds: readonly number[];
}

/** Seconds to whole milliseconds (rounded). */
export function alineacionDesdeSegundos(raw: AlineacionEnSegundos): AlineacionCaracteres {
  if (raw.characters.length !== raw.character_start_times_seconds.length || raw.characters.length !== raw.character_end_times_seconds.length) {
    throw new AlineacionInvalidaError('longitudes_distintas');
  }
  const ms = (s: number): number => {
    if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) throw new AlineacionInvalidaError('valor_invalido');
    return Math.round(s * 1000);
  };
  return { caracteres: raw.characters, inicioMs: raw.character_start_times_seconds.map(ms), finMs: raw.character_end_times_seconds.map(ms) };
}

interface Unidad {
  texto: string;
  inicioMs: number;
  finMs: number;
  /** False for a character the text has and the alignment lacks. */
  medida: boolean;
}

const ESPACIO = /^\s$/u;
const COMBINANTE = /^\p{M}$/u;

function validar(a: AlineacionCaracteres): void {
  if (a.caracteres.length !== a.inicioMs.length || a.caracteres.length !== a.finMs.length) throw new AlineacionInvalidaError('longitudes_distintas');
  let anterior = 0;
  for (let i = 0; i < a.caracteres.length; i++) {
    const ini = a.inicioMs[i]!;
    const fin = a.finMs[i]!;
    if (typeof a.caracteres[i] !== 'string' || a.caracteres[i] === '') throw new AlineacionInvalidaError('valor_invalido');
    if (!Number.isInteger(ini) || !Number.isInteger(fin) || ini < 0 || fin < 0) throw new AlineacionInvalidaError('valor_invalido');
    if (fin < ini || ini < anterior) throw new AlineacionInvalidaError('tiempos_no_crecientes');
    anterior = ini;
  }
}

/** Groups the alignment into characters of the text: a combining mark joins the character before it. */
function unidades(a: AlineacionCaracteres): Unidad[] {
  const salida: Unidad[] = [];
  for (let i = 0; i < a.caracteres.length; i++) {
    for (const cp of a.caracteres[i]!) {
      const previa = salida[salida.length - 1];
      if (previa && COMBINANTE.test(cp)) {
        previa.texto += cp;
        previa.finMs = Math.max(previa.finMs, a.finMs[i]!);
      } else {
        salida.push({ texto: cp, inicioMs: a.inicioMs[i]!, finMs: a.finMs[i]!, medida: true });
      }
    }
  }
  for (const u of salida) u.texto = u.texto.normalize('NFC');
  return salida;
}

const mismoCaracter = (esperado: string, unidad: string): boolean => esperado === unidad || (ESPACIO.test(esperado) && ESPACIO.test(unidad));

/**
 * The time of each word of `texto`, in ms from the start of the SCENE.
 * `desplazamientoMs` is where the voice starts inside the scene (its lead-in margin); `duracionEscenaMs`
 * is the rendered scene, where the last word ends. Throws AlineacionInvalidaError (reason only).
 */
export function alineacionAPalabras(
  alineacion: AlineacionCaracteres,
  texto: string,
  duracionEscenaMs: number,
  desplazamientoMs = 0,
): TiempoPalabra[] {
  if (!Number.isInteger(duracionEscenaMs) || duracionEscenaMs < 1 || !Number.isInteger(desplazamientoMs) || desplazamientoMs < 0) {
    throw new AlineacionInvalidaError('valor_invalido');
  }
  validar(alineacion);
  const esperado = [...texto.normalize('NFC')];
  const dadas = unidades(alineacion);

  // Walk the text and the alignment together; at most one character at a time may be missing.
  const empareja: Unidad[] = [];
  let u = 0;
  for (let i = 0; i < esperado.length; i++) {
    const caracter = esperado[i]!;
    const actual = dadas[u];
    if (actual && mismoCaracter(caracter, actual.texto)) {
      empareja.push(actual);
      u++;
    } else if (actual && i + 1 < esperado.length && mismoCaracter(esperado[i + 1]!, actual.texto) && !ESPACIO.test(caracter)) {
      const vecino = empareja[empareja.length - 1];
      const t = vecino ? vecino.finMs : actual.inicioMs;
      empareja.push({ texto: caracter, inicioMs: t, finMs: t, medida: false });
    } else if (!actual && i === esperado.length - 1 && !ESPACIO.test(caracter) && empareja.length > 0) {
      const t = empareja[empareja.length - 1]!.finMs;
      empareja.push({ texto: caracter, inicioMs: t, finMs: t, medida: false });
    } else {
      throw new AlineacionInvalidaError('no_coincide_con_el_texto');
    }
  }
  if (u !== dadas.length) throw new AlineacionInvalidaError('no_coincide_con_el_texto');

  // Characters of each word, in order.
  const palabras = palabrasDe(texto);
  const grupos: Unidad[][] = [];
  let actualGrupo: Unidad[] = [];
  for (let i = 0; i < esperado.length; i++) {
    if (ESPACIO.test(esperado[i]!)) {
      if (actualGrupo.length > 0) grupos.push(actualGrupo);
      actualGrupo = [];
    } else {
      actualGrupo.push(empareja[i]!);
    }
  }
  if (actualGrupo.length > 0) grupos.push(actualGrupo);
  if (grupos.length !== palabras.length) throw new AlineacionInvalidaError('no_coincide_con_el_texto');

  // A word must have at least one timed character.
  const inicios: number[] = [];
  for (const grupo of grupos) {
    const medidas = grupo.filter((c) => c.medida);
    if (medidas.length === 0) throw new AlineacionInvalidaError('palabra_sin_tiempos');
    // The first character of the word, timed or interpolated from its neighbour.
    inicios.push(grupo[0]!.inicioMs + desplazamientoMs);
  }
  // Strictly increasing starts, so every word lasts at least 1 ms.
  for (let i = 1; i < inicios.length; i++) if (inicios[i]! <= inicios[i - 1]!) inicios[i] = inicios[i - 1]! + 1;
  if (inicios.length > 0 && inicios[inicios.length - 1]! >= duracionEscenaMs) throw new AlineacionInvalidaError('fuera_de_la_escena');

  return palabras.map((palabra, i) => ({
    palabra,
    inicioMs: inicios[i]!,
    finMs: i === palabras.length - 1 ? duracionEscenaMs : inicios[i + 1]!,
  }));
}
