import type { MediaRow } from './mediaRepository.js';

/**
 * What the API returns for a media item. The storage key and the file hash are internal and are
 * not part of it; files are reached only through short-lived signed URLs.
 */
export interface MediaView {
  id: string;
  tipo: 'foto' | 'video';
  mime: string;
  tamano_bytes: number;
  ancho: number;
  alto: number;
  duracion_ms: number | null;
  etiquetas: string[];
  origen_derechos: string;
  nota_licencia: string | null;
  derechos_hasta: Date | null;
  aparecen_personas: boolean;
  autorizacion_ids: string[];
  nombre_original: string;
  subido_por: string | null;
  creado_en: Date;
}

export function toMediaView(row: MediaRow): MediaView {
  return {
    id: row.id,
    tipo: row.tipo,
    mime: row.mime,
    tamano_bytes: row.tamano_bytes,
    ancho: row.ancho,
    alto: row.alto,
    duracion_ms: row.duracion_ms,
    etiquetas: row.etiquetas,
    origen_derechos: row.origen_derechos,
    nota_licencia: row.nota_licencia,
    derechos_hasta: row.derechos_hasta,
    aparecen_personas: row.aparecen_personas,
    autorizacion_ids: row.autorizacion_ids,
    nombre_original: row.nombre_original,
    subido_por: row.subido_por,
    creado_en: row.creado_en,
  };
}
