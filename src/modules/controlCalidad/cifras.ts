import { mentionsNumber } from '../directorCreativo/detectors.js';
import { isValidAt, tokenIdsIn } from '../directorCreativo/tokens.js';
import { mentionsPrice, mentionsPromotion, mentionsSchedule } from '../planificador/textMatch.js';
import type { HechoTipo } from '../planificador/types.js';
import { crearCheck } from './crearCheck.js';
import { idDeCampo, type CampoPublicado, type CheckQC } from './tipos.js';

// Rule 2: every number, price, time or percentage that is published comes from a cited verified fact.
//
// The brief writes `{{hecho:id}}` tokens and the stored text has each token replaced by the fact's text
// at that moment. So, for each field, the facts it cites are the tokens of its `modelo`, and the stored
// `texto` must still hold their CURRENT text. Quality control removes that text and looks for figures in
// what is left: a free figure fails (`cifra_libre`), a fact edited since fails (`hecho_texto_cambiado`)
// and a fact that is not valid now and at the piece's instant fails (`hecho_no_vigente`).

export interface HechoQC {
  id: string;
  tipo: HechoTipo;
  /** The CURRENT text of the fact. */
  enunciado: string;
  vigente_desde: Date;
  vigente_hasta: Date | null;
}

export interface EntradaCifras {
  campos: readonly CampoPublicado[];
  /** The current rows of the facts the piece cites (a cited id that is missing here no longer exists). */
  hechos: readonly HechoQC[];
  ahora: Date;
  /** The instant the piece will be published (`fecha_hora`). */
  instantePieza: Date;
}

const nfc = (texto: string): string => texto.normalize('NFC');

/** Lowercase ids of the facts a field cites, without repeats. */
function idsCitados(campo: CampoPublicado): string[] {
  return [...new Set(tokenIdsIn(campo.modelo ?? ''))];
}

export function checksCifras(e: EntradaCifras): CheckQC[] {
  const porId = new Map(e.hechos.map((h) => [h.id.toLowerCase(), h]));
  const citadosTodos = [...new Set(e.campos.flatMap(idsCitados))];
  const tiposCitados = new Set(citadosTodos.flatMap((id) => (porId.has(id) ? [porId.get(id)!.tipo] : [])));

  const camposLibres: string[] = [];
  const camposCambiados: string[] = [];
  const hechosCambiados = new Set<string>();

  for (const campo of e.campos) {
    const ids = idsCitados(campo);
    let resto = nfc(campo.texto);
    for (const id of ids) {
      const hecho = porId.get(id);
      if (!hecho || hecho.enunciado === '') continue;
      const enunciado = nfc(hecho.enunciado);
      if (!nfc(campo.texto).includes(enunciado)) {
        camposCambiados.push(idDeCampo(campo));
        hechosCambiados.add(id);
      }
      resto = resto.split(enunciado).join(' ');
    }
    // A figure outside the facts the field cites. The wording of a price, schedule or promotion needs a
    // fact of that type somewhere in the piece (as in the brief); hashtags are exempt from the wording.
    const palabras = campo.campo !== 'hashtag';
    const libre =
      mentionsNumber(resto) ||
      (palabras && mentionsPrice(resto) && !tiposCitados.has('precio')) ||
      (palabras && mentionsSchedule(resto) && !tiposCitados.has('horario')) ||
      (palabras && mentionsPromotion(resto) && !tiposCitados.has('promocion'));
    if (libre) camposLibres.push(idDeCampo(campo));
  }

  const noVigentes = citadosTodos.filter((id) => {
    const hecho = porId.get(id);
    return !hecho || !isValidAt(hecho, e.ahora) || !isValidAt(hecho, e.instantePieza);
  });

  return [
    crearCheck('cifra_libre', camposLibres.length === 0, { campos: camposLibres }),
    crearCheck('hecho_texto_cambiado', camposCambiados.length === 0, { campos: camposCambiados, hecho_ids: [...hechosCambiados] }),
    crearCheck('hecho_no_vigente', noVigentes.length === 0, { hecho_ids: noVigentes }),
  ];
}
