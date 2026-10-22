// The props of a text layer, as the server builds and validates them (src/modules/produccion/propsPlantilla.ts,
// strict zod schema). Declared here again so this folder stays self-contained: it is bundled by itself for the
// browser. A test in src/ checks that the server's type fits this one.
//
// CLIENT TEXT is only `PalabraProps.texto`. It is rendered as a React text child and nowhere else.

export type PalabraProps = {
  texto: string;
  inicioMs: number;
  finMs: number;
  inicioFotograma: number;
  finFotograma: number;
};

// A type alias (not an interface): Remotion requires props assignable to Record<string, unknown>.
export type PropsCapa = {
  plantilla: string;
  version: number;
  ancho: number;
  alto: number;
  fps: number;
  fotogramas: number;
  fuente: 'Inter';
  colores: { texto: string; scrim: string; alfa: number };
  /** The translucent band behind the text, in pixels. */
  scrim: { y: number; alto: number };
  tamano: number;
  interlineadoPx: number;
  /** Top of the text block, in pixels. */
  bloqueArriba: number;
  posicion: 'abajo' | 'centro';
  modo: 'bloque' | 'palabras' | 'titulo';
  lineas: { palabras: PalabraProps[] }[];
};

/** The composition id of a template: Remotion ids accept letters, digits and "-" only. */
export const idComposicion = (plantilla: string, version: number): string => `${plantilla.replace(/_/g, '-')}-v${version}`;
