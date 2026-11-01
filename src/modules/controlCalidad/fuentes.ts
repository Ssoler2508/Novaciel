import { crearCheck } from './crearCheck.js';
import type { CheckQC } from './tipos.js';

// Rule 6 (real media first; AI never generates the product, the premises or real people of the client).
// Today the `tomas` table only admits `media_real` and `faltante`, so `fuente_ia_no_permitida` always passes:
// it is the safety net for the future step that generates media. `toma_faltante` is a different failure
// (a scene with no media at all) and has its own code.

export interface TomaQC {
  orden: number;
  /** `tomas.fuente`. */
  fuente: string;
  mediaId: string | null;
}

export interface EntradaFuentes {
  tomas: readonly TomaQC[];
  /** `producciones_archivos`: the media each final file was made from. */
  archivos: readonly { orden: number; mediaId: string }[];
  /** `producciones_fuentes`: the clips of a reel. */
  fuentesReel: readonly { ordenArchivo: number; escena: number; mediaId: string }[];
  /** The ids of the media of THIS client's library (loaded filtered by `cliente_id`). */
  biblioteca: ReadonlySet<string>;
}

const FUENTES_IA = ['generacion_ia', 'animacion_ia'] as const;
const FUENTES_CONOCIDAS = ['media_real', 'faltante', ...FUENTES_IA];

/** A `fuente` as a closed label: a value the table does not know is reported as `desconocida`. */
const etiqueta = (fuente: string): string => (FUENTES_CONOCIDAS.includes(fuente) ? fuente : 'desconocida');

export function checksFuentes(e: EntradaFuentes): CheckQC[] {
  const tomasIa = e.tomas.filter((t) => t.fuente !== 'media_real' && t.fuente !== 'faltante');
  const archivosFuera = e.archivos.filter((a) => !e.biblioteca.has(a.mediaId));
  const clipsFuera = e.fuentesReel.filter((c) => !e.biblioteca.has(c.mediaId));
  const cumple = tomasIa.length === 0 && archivosFuera.length === 0 && clipsFuera.length === 0;

  return [
    crearCheck('fuente_ia_no_permitida', cumple, {
      tomas: tomasIa.map((t) => t.orden),
      fuentes: [...new Set(tomasIa.map((t) => etiqueta(t.fuente)))].sort(),
      archivos: archivosFuera.map((a) => a.orden),
      clips: clipsFuera.map((c) => `${c.ordenArchivo}:${c.escena}`),
    }),
    crearCheck('toma_faltante', !e.tomas.some((t) => t.fuente === 'faltante'), {
      tomas: e.tomas.filter((t) => t.fuente === 'faltante').map((t) => t.orden),
    }),
  ];
}
