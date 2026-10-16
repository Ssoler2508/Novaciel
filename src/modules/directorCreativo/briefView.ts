import type { GuionView, TomaView } from './guionesRepository.js';
import type { BriefContent } from './schema.js';

// What the API returns for a brief: the RENDERED content (fact tokens already replaced by the
// stored values), its slots, the cited fact ids and the version. Never the prompt and never the
// model's raw output (contenido_modelo, with tokens): toBriefView does not even read it.

export interface BriefView {
  id: string;
  pieza_id: string;
  version: number;
  es_actual: boolean;
  formato: GuionView['formato'];
  perfil_marca_id: string;
  contenido: BriefContent;
  tomas: TomaView[];
  hecho_ids: string[];
  creado_por: string | null;
  creado_en: Date;
}

export function toBriefView(guion: GuionView): BriefView {
  return {
    id: guion.id,
    pieza_id: guion.pieza_id,
    version: guion.version,
    es_actual: guion.es_actual,
    formato: guion.formato,
    perfil_marca_id: guion.perfil_marca_id,
    contenido: guion.contenido,
    tomas: guion.tomas.map((t) => ({ ...t })),
    hecho_ids: [...guion.hecho_ids],
    creado_por: guion.creado_por,
    creado_en: guion.creado_en,
  };
}
