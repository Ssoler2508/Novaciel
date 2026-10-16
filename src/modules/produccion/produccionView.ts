import type { Storage } from '../../lib/media/storage/types.js';
import type { ProduccionView } from './produccionRepository.js';

// What the production routes show. The storage key is NEVER exposed: each file carries a short-lived
// signed URL instead.

export interface ArchivoPublico {
  orden: number;
  mime: string;
  ancho: number;
  alto: number;
  tamano_bytes: number;
  sha256: string;
  media_id: string;
  url: string;
  url_expira_en_s: number;
}

export interface ProduccionPublica {
  id: string;
  pieza_id: string;
  guion_id: string;
  version: number;
  es_actual: boolean;
  red: string;
  texto_publicacion: string;
  hashtags: string[];
  textos_alternativos: string[];
  ubicacion: string | null;
  hash_version: string;
  hash_pieza: string;
  archivos: ArchivoPublico[];
  creado_en: string;
}

export async function toProduccionPublica(
  storage: Pick<Storage, 'getSignedUrl'>,
  produccion: ProduccionView,
  ttlSeconds: number,
): Promise<ProduccionPublica> {
  const archivos = await Promise.all(
    produccion.archivos.map(
      async (a): Promise<ArchivoPublico> => ({
        orden: a.orden,
        mime: a.mime,
        ancho: a.ancho,
        alto: a.alto,
        tamano_bytes: a.tamano_bytes,
        sha256: a.sha256,
        media_id: a.media_id,
        url: await storage.getSignedUrl(a.clave_almacenamiento, ttlSeconds),
        url_expira_en_s: ttlSeconds,
      }),
    ),
  );
  return {
    id: produccion.id,
    pieza_id: produccion.pieza_id,
    guion_id: produccion.guion_id,
    version: produccion.version,
    es_actual: produccion.es_actual,
    red: produccion.red,
    texto_publicacion: produccion.texto_publicacion,
    hashtags: produccion.hashtags,
    textos_alternativos: produccion.textos_alternativos,
    ubicacion: produccion.ubicacion,
    hash_version: produccion.hash_version,
    hash_pieza: produccion.hash_pieza,
    archivos,
    creado_en: produccion.creado_en.toISOString(),
  };
}
