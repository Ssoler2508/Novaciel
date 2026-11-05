import { getJson } from './http.js';

// Shapes match the backend routes of Step 9 and Step 8. The getters rebuild the responses with only
// the fields the screen uses, so hashes, media ids and storage keys never reach the UI state.

export interface EstadoAprobacion {
  estado: string;
  ronda?: number;
}

export interface HistorialAprobacion {
  nivel: string;
  decision: string;
  motivo: string | null;
  segundo_ms: number | null;
  version: number;
  creado_en: string;
  propia: boolean;
  comentario: string | null;
}

export interface PiezaRevision {
  pieza_estado: string;
  fecha_hora: string;
  estado_aprobacion: EstadoAprobacion;
  historial: HistorialAprobacion[];
}

export interface VideoFuente {
  escena: number;
  entrada_ms: number;
  salida_ms: number;
}

export interface VideoInfo {
  duracion_ms: number;
  fps: number;
  codec_video: string;
  codec_audio: string;
  fuentes: VideoFuente[];
}

export interface ProduccionArchivo {
  orden: number;
  mime: string;
  ancho: number;
  alto: number;
  tamano_bytes: number;
  video: VideoInfo | null;
  url: string;
  url_expira_en_s: number;
}

export interface ProduccionPlantilla {
  id: string;
  version: number;
}

export interface PiezaProduccion {
  version: number;
  plantilla: ProduccionPlantilla | null;
  archivos: ProduccionArchivo[];
}

export interface BriefEscena {
  orden: number;
  texto_en_pantalla: string;
  texto_alternativo?: string;
  voz_en_off?: string;
  duracion_s?: number;
}

export interface BriefContenido {
  formato: string;
  gancho: string;
  escenas: BriefEscena[];
  texto_publicacion: { texto: string; hashtags: string[]; ubicacion?: string };
  llamado_a_accion: string;
  musica?: string;
  portada?: string;
  notas_produccion: string;
}

export interface BriefToma {
  orden: number;
  fuente: string;
  motivo_faltante: string | null;
  entrada_ms: number | null;
  salida_ms: number | null;
}

export interface PiezaBrief {
  version: number;
  es_actual: boolean;
  formato: string;
  contenido: BriefContenido;
  tomas: BriefToma[];
  hecho_count: number;
  creado_en: string;
}

export interface QcCheck {
  codigo: string;
  resultado: string;
  severidad: string;
  motivo: string;
}

export interface QcInforme {
  version: number;
  resultado: string;
  checks: QcCheck[];
  codigos_fallo: string[];
  codigos_advertencia: string[];
  creado_en: string;
}

export interface PiezaControlCalidad {
  pieza_estado: string;
  vigente: boolean;
  informe: QcInforme | null;
}

interface ProduccionArchivoRaw extends ProduccionArchivo {
  sha256: string;
  media_id: string | null;
}

interface ProduccionResponse {
  version: number;
  plantilla: ProduccionPlantilla | null;
  archivos: ProduccionArchivoRaw[];
}

interface BriefTomaRaw extends BriefToma {
  media_id: string | null;
}

interface BriefResponse {
  version: number;
  es_actual: boolean;
  formato: string;
  contenido: BriefContenido;
  tomas: BriefTomaRaw[];
  hecho_ids: string[];
  creado_en: string;
}

interface QcInformeRaw extends QcInforme {
  produccion_id?: string;
  hash_version?: string;
  hash_pieza?: string;
  actor_tipo?: string;
}

interface QcResponse {
  pieza_estado: string;
  vigente: boolean;
  informe: QcInformeRaw | null;
}

function basePath(clienteId: string, piezaId: string): string {
  return `/clientes/${encodeURIComponent(clienteId)}/piezas/${encodeURIComponent(piezaId)}`;
}

function pickEstadoAprobacion(estado: EstadoAprobacion): EstadoAprobacion {
  return typeof estado.ronda === 'number'
    ? { estado: estado.estado, ronda: estado.ronda }
    : { estado: estado.estado };
}

function pickRevision(data: PiezaRevision): PiezaRevision {
  return {
    pieza_estado: data.pieza_estado,
    fecha_hora: data.fecha_hora,
    estado_aprobacion: pickEstadoAprobacion(data.estado_aprobacion),
    historial: data.historial.map((item) => ({
      nivel: item.nivel,
      decision: item.decision,
      motivo: item.motivo,
      segundo_ms: item.segundo_ms,
      version: item.version,
      creado_en: item.creado_en,
      propia: item.propia,
      comentario: item.comentario,
    })),
  };
}

function pickVideo(video: VideoInfo | null): VideoInfo | null {
  if (video === null) return null;
  return {
    duracion_ms: video.duracion_ms,
    fps: video.fps,
    codec_video: video.codec_video,
    codec_audio: video.codec_audio,
    fuentes: video.fuentes.map((fuente) => ({
      escena: fuente.escena,
      entrada_ms: fuente.entrada_ms,
      salida_ms: fuente.salida_ms,
    })),
  };
}

function pickProduccion(data: ProduccionResponse): PiezaProduccion {
  return {
    version: data.version,
    plantilla:
      data.plantilla === null
        ? null
        : { id: data.plantilla.id, version: data.plantilla.version },
    archivos: data.archivos.map((archivo) => ({
      orden: archivo.orden,
      mime: archivo.mime,
      ancho: archivo.ancho,
      alto: archivo.alto,
      tamano_bytes: archivo.tamano_bytes,
      video: pickVideo(archivo.video),
      url: archivo.url,
      url_expira_en_s: archivo.url_expira_en_s,
    })),
  };
}

function pickBrief(data: BriefResponse): PiezaBrief {
  const contenido = data.contenido;

  return {
    version: data.version,
    es_actual: data.es_actual,
    formato: data.formato,
    contenido: {
      formato: contenido.formato,
      gancho: contenido.gancho,
      escenas: contenido.escenas.map((escena) => ({
        orden: escena.orden,
        texto_en_pantalla: escena.texto_en_pantalla,
        ...(escena.texto_alternativo !== undefined
          ? { texto_alternativo: escena.texto_alternativo }
          : {}),
        ...(escena.voz_en_off !== undefined ? { voz_en_off: escena.voz_en_off } : {}),
        ...(typeof escena.duracion_s === 'number' ? { duracion_s: escena.duracion_s } : {}),
      })),
      texto_publicacion: {
        texto: contenido.texto_publicacion.texto,
        hashtags: [...contenido.texto_publicacion.hashtags],
        ...(contenido.texto_publicacion.ubicacion !== undefined
          ? { ubicacion: contenido.texto_publicacion.ubicacion }
          : {}),
      },
      llamado_a_accion: contenido.llamado_a_accion,
      ...(contenido.musica !== undefined ? { musica: contenido.musica } : {}),
      ...(contenido.portada !== undefined ? { portada: contenido.portada } : {}),
      notas_produccion: contenido.notas_produccion,
    },
    tomas: data.tomas.map((toma) => ({
      orden: toma.orden,
      fuente: toma.fuente,
      motivo_faltante: toma.motivo_faltante,
      entrada_ms: toma.entrada_ms,
      salida_ms: toma.salida_ms,
    })),
    hecho_count: data.hecho_ids.length,
    creado_en: data.creado_en,
  };
}

function pickQc(data: QcResponse): PiezaControlCalidad {
  return {
    pieza_estado: data.pieza_estado,
    vigente: data.vigente,
    informe:
      data.informe === null
        ? null
        : {
            version: data.informe.version,
            resultado: data.informe.resultado,
            checks: data.informe.checks.map((check) => ({
              codigo: check.codigo,
              resultado: check.resultado,
              severidad: check.severidad,
              motivo: check.motivo,
            })),
            codigos_fallo: [...data.informe.codigos_fallo],
            codigos_advertencia: [...data.informe.codigos_advertencia],
            creado_en: data.informe.creado_en,
          },
  };
}

export async function getPiezaRevision(
  clienteId: string,
  piezaId: string,
): Promise<PiezaRevision> {
  return pickRevision(
    await getJson<PiezaRevision>(`${basePath(clienteId, piezaId)}/revision`),
  );
}

export async function getPiezaProduccion(
  clienteId: string,
  piezaId: string,
): Promise<PiezaProduccion> {
  return pickProduccion(
    await getJson<ProduccionResponse>(`${basePath(clienteId, piezaId)}/produccion`),
  );
}

export async function getPiezaBrief(
  clienteId: string,
  piezaId: string,
): Promise<PiezaBrief> {
  return pickBrief(await getJson<BriefResponse>(`${basePath(clienteId, piezaId)}/brief`));
}

export async function getPiezaControlCalidad(
  clienteId: string,
  piezaId: string,
): Promise<PiezaControlCalidad> {
  return pickQc(
    await getJson<QcResponse>(`${basePath(clienteId, piezaId)}/control-calidad`),
  );
}
