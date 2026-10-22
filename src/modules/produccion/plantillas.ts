import type { LicenciaRemotion } from './remotionLicencia.js';

// The registry of animated text templates (Step 7c), pure data. A template is identified by `id` and
// `version`; a change to how a template looks is a NEW version (the production records both). Colors
// come from the client's kit_visual through the 7a contrast rule, fonts only from assets/fonts and the
// safe zone from 7a; the registry says which template exists, not how it is drawn.

export interface Plantilla {
  id: string;
  version: number;
  descripcion: string;
  /** True when the first scene is drawn as a title card (the hook) and the rest word by word. */
  escenaTitulo: boolean;
}

export const PLANTILLAS: readonly Plantilla[] = [
  { id: 'barra_inferior', version: 1, descripcion: 'Text at the bottom of the safe zone on a scrim (the 7a look), animated in', escenaTitulo: false },
  { id: 'palabra_a_palabra', version: 1, descripcion: 'The scene text appears word by word', escenaTitulo: false },
  { id: 'titulo_y_palabras', version: 1, descripcion: 'Title card for the first scene, word by word afterwards', escenaTitulo: true },
];

/** The same format the database accepts for producciones.plantilla. */
export const FORMATO_ID_PLANTILLA = /^[a-z0-9_]{1,40}$/;

export function getPlantilla(id: string, version?: number): Plantilla | undefined {
  return PLANTILLAS.find((p) => p.id === id && (version === undefined || p.version === version));
}

/** The latest version of a template. */
export function ultimaVersion(id: string): Plantilla | undefined {
  return PLANTILLAS.filter((p) => p.id === id).sort((a, b) => b.version - a.version)[0];
}

export type TrabajoPieza = 'atraer' | 'confianza' | 'accion';

/** The default template for the "trabajo" of a piece (spec 7, rule 2), when the client names none. */
export const PLANTILLA_POR_TRABAJO: Readonly<Record<TrabajoPieza, string>> = {
  atraer: 'titulo_y_palabras',
  confianza: 'barra_inferior',
  accion: 'palabra_a_palabra',
};

/**
 * Who picks the template: CODE, not the brief (Step 6 does not change). The client's own default wins
 * when `kit_visual.plantilla_subtitulos` names a registry template (today's seed value "plantilla-2" does
 * not, so it is ignored); otherwise the piece's "trabajo" decides. With no Remotion license declared,
 * Remotion is disabled and NO template is picked (the reel keeps the 7b PNG overlays).
 */
export function elegirPlantilla(params: {
  licencia: LicenciaRemotion | undefined;
  kitVisual: unknown;
  trabajo: TrabajoPieza;
}): Plantilla | null {
  if (params.licencia === undefined) return null;
  const propia = (params.kitVisual as { plantilla_subtitulos?: unknown } | null | undefined)?.plantilla_subtitulos;
  if (typeof propia === 'string') {
    const elegida = ultimaVersion(propia);
    if (elegida) return elegida;
  }
  return ultimaVersion(PLANTILLA_POR_TRABAJO[params.trabajo]) ?? null;
}
