import { CONTRASTE_MINIMO, elegirColores, type ColoresSlide } from '../produccion/colors.js';
import { contarGlifosNoSoportados, esTextoSoportado } from '../produccion/glyphCoverage.js';
import { crearCheck } from './crearCheck.js';
import type { CheckQC } from './tipos.js';

// Brand checks, against the brand profile VERSION the production was rendered with (`producciones.perfil_marca_id`;
// for older productions, the one of the brief), not the current one: profile rows are immutable versions, so a
// kit edited later does not fail a render that was correct when it was made. Whoever calls this must pass the
// `kit_visual` of THAT row and say where it came from (`perfilOrigen`).

/**
 * The fonts a render may use. The renderer bundles Inter only (`FUENTE_POR_DEFECTO` in
 * produccion/fonts.ts, which loads canvas and is not imported here; a test keeps both in step).
 */
export const FUENTES_PERMITIDAS: readonly string[] = ['Inter'];

export interface EntradaMarca {
  /** The brand profile version being judged. It is recorded in the parameters of every colour and font check. */
  perfilMarcaId: string;
  /** `kit_visual` of that profile row. */
  kitVisual: unknown;
  /** The font the production was rendered with. */
  fuenteRender: string;
  /** The on-screen texts of the rendered brief, in scene order. */
  textosEnPantalla: readonly string[];
  /** Where `perfilMarcaId` comes from: the profile the production recorded, or (older productions) the brief's. */
  perfilOrigen: 'produccion' | 'brief';
}

/** The contrast rule on the colours a render chose. Separate so it can be tested with any colours. */
export function checkContraste(perfilMarcaId: string, colores: Pick<ColoresSlide, 'contraste'>, perfilOrigen: EntradaMarca['perfilOrigen'] = 'produccion'): CheckQC {
  return crearCheck('marca_contraste', colores.contraste >= CONTRASTE_MINIMO, {
    perfil_marca_id: perfilMarcaId,
    perfil_origen: perfilOrigen,
    contraste: Math.round(colores.contraste * 100) / 100,
    minimo: CONTRASTE_MINIMO,
  });
}

export function checksMarca(e: EntradaMarca): CheckQC[] {
  const colores = elegirColores(e.kitVisual);
  const sinGlifos = e.textosEnPantalla.flatMap((t, i) => (esTextoSoportado(t) ? [] : [i]));
  const fuentePermitida = FUENTES_PERMITIDAS.includes(e.fuenteRender);

  return [
    checkContraste(e.perfilMarcaId, colores, e.perfilOrigen),
    crearCheck('marca_colores_respaldo', colores.origen !== 'respaldo', { perfil_marca_id: e.perfilMarcaId, perfil_origen: e.perfilOrigen }),
    crearCheck('marca_fuente_no_permitida', fuentePermitida, { perfil_marca_id: e.perfilMarcaId, perfil_origen: e.perfilOrigen, fuente_permitida: fuentePermitida }),
    crearCheck('marca_glifos_no_soportados', sinGlifos.length === 0, {
      escenas: sinGlifos,
      caracteres: e.textosEnPantalla.reduce((total, t) => total + contarGlifosNoSoportados(t), 0),
    }),
  ];
}
