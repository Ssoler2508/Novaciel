import type { CodigoQC } from './catalogo.js';

// Quality control (Step 8). Everything in this module is PURE: it receives data already loaded and
// returns checks. Loading the data, re-reading the files and storing the report is checkpoint C.

export type ResultadoCheck = 'pasa' | 'no_pasa' | 'advertencia';
export type Severidad = 'bloqueante' | 'advertencia';
export type ResultadoQC = 'aprobado' | 'rechazado';

/** Parameters of a check: numbers, booleans and CLOSED identifiers (codes, ids, positions). Never client text. */
export type ParametroValor = string | number | boolean | readonly (string | number | boolean)[];
export type Parametros = Readonly<Record<string, ParametroValor>>;

/** One check, in the shape stored in `revisiones_calidad.checks`. */
export interface CheckQC {
  codigo: CodigoQC;
  resultado: ResultadoCheck;
  severidad: Severidad;
  /** A fixed phrase of the catalogue ("Cumple." when it passes). */
  motivo: string;
  parametros: Parametros;
}

/** A text that will be published (or drawn on screen), with where it comes from. */
export interface CampoPublicado {
  campo: 'texto_publicacion' | 'hashtag' | 'texto_alternativo' | 'texto_en_pantalla' | 'ubicacion';
  /** Position inside its kind (hashtag 0, alt text 2, scene 1...). */
  indice: number;
  /** What is published: the stored copy of the production, or the on-screen text of the rendered brief. */
  texto: string;
  /** The model's text of the same field, with `{{hecho:id}}` tokens, when the brief has one. */
  modelo?: string;
}

/** A closed identifier of a field, safe to put in `parametros` (for example `hashtag:2`). */
export function idDeCampo(campo: Pick<CampoPublicado, 'campo' | 'indice'>): string {
  return `${campo.campo}:${campo.indice}`;
}
