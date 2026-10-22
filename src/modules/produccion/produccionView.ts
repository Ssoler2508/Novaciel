import type { Storage } from '../../lib/media/storage/types.js';
import type { ProduccionView } from './produccionRepository.js';

// What the production routes show. The storage key is NEVER exposed: each file carries a short-lived
// signed URL instead.

/** What is known about a video file: its technical record and the stretch of each clip behind each scene. */
export interface VideoPublico {
  duracion_ms: number;
  fps: number;
  codec_video: string;
  codec_audio: string;
  fuentes: { escena: number; media_id: string; entrada_ms: number; salida_ms: number }[];
}

export interface ArchivoPublico {
  orden: number;
  mime: string;
  ancho: number;
  alto: number;
  tamano_bytes: number;
  sha256: string;
  /** For a reel, the clip of its first scene (all of them are in `video.fuentes`). */
  media_id: string;
  /** Null for an image. */
  video: VideoPublico | null;
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
  /** The animated text template the reel was made with; null for images and for reels with plain PNG overlays. */
  plantilla: { id: string; version: number } | null;
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
        video:
          a.duracion_ms === null || a.fps === null || a.codec_video === null || a.codec_audio === null
            ? null
            : { duracion_ms: a.duracion_ms, fps: a.fps, codec_video: a.codec_video, codec_audio: a.codec_audio, fuentes: a.fuentes.map((f) => ({ ...f })) },
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
    plantilla: produccion.plantilla !== null && produccion.plantilla_version !== null ? { id: produccion.plantilla, version: produccion.plantilla_version } : null,
    archivos,
    creado_en: produccion.creado_en.toISOString(),
  };
}
