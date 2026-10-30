import { limitesDe } from '../directorCreativo/limits.js';
import { HASHTAG } from '../directorCreativo/schema.js';
import type { Formato } from '../planificador/types.js';
import { crearCheck } from './crearCheck.js';
import type { CheckQC } from './tipos.js';

// Format rules of what is published: lengths, hashtags, alt texts, location and the number of slides.
// The limits are the ones of the brief (directorCreativo/limits.ts, house values marked VERIFICAR; they
// are the same for every network) and the length is measured the same way (`.length`), so what passed
// the brief passes here.

export interface EntradaTextos {
  formato: Formato;
  textoPublicacion: string;
  /** With their `#`, in published order. */
  hashtags: readonly string[];
  textosAlternativos: readonly string[];
  ubicacion: string | null;
  /** Final files of the production. */
  numArchivos: number;
  /** Scenes of a reel (distinct scenes in `producciones_fuentes`); null for other formats. */
  numEscenasReel: number | null;
}

const indicesDonde = <T>(lista: readonly T[], cond: (item: T) => boolean): number[] => lista.flatMap((item, i) => (cond(item) ? [i] : []));

export function checksTextos(e: EntradaTextos): CheckQC[] {
  const limites = limitesDe(e.formato);
  const alts = e.textosAlternativos;

  const sinAlt = limites.formato.requiereTextoAlternativo
    ? Array.from({ length: e.numArchivos }, (_v, i) => i).filter((i) => (alts[i] ?? '').trim() === '')
    : [];
  const cantidad = e.formato === 'reel' ? (e.numEscenasReel ?? 0) : e.numArchivos;

  return [
    crearCheck('texto_publicacion_largo', e.textoPublicacion.length <= limites.texto.textoPublicacion, {
      longitud: e.textoPublicacion.length,
      maximo: limites.texto.textoPublicacion,
    }),
    crearCheck('hashtags_cantidad', e.hashtags.length <= limites.hashtagsMax, { cantidad: e.hashtags.length, maximo: limites.hashtagsMax }),
    crearCheck('hashtags_forma', e.hashtags.every((h) => HASHTAG.test(h)), { indices: indicesDonde(e.hashtags, (h) => !HASHTAG.test(h)) }),
    crearCheck('texto_alternativo_largo', alts.every((a) => a.length <= limites.texto.textoAlternativo), {
      indices: indicesDonde(alts, (a) => a.length > limites.texto.textoAlternativo),
      maximo: limites.texto.textoAlternativo,
    }),
    crearCheck('texto_alternativo_falta', sinAlt.length === 0, { indices: sinAlt }),
    crearCheck('ubicacion_larga', e.ubicacion === null || e.ubicacion.length <= limites.texto.ubicacion, {
      longitud: e.ubicacion?.length ?? 0,
      maximo: limites.texto.ubicacion,
    }),
    crearCheck('diapositivas_cantidad', cantidad >= limites.formato.escenasMin && cantidad <= limites.formato.escenasMax, {
      cantidad,
      minimo: limites.formato.escenasMin,
      maximo: limites.formato.escenasMax,
    }),
  ];
}
