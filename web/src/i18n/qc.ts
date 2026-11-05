// Spanish reasons for the quality-control codes, copied from src/modules/controlCalidad/catalogo.ts
// (the source of truth). A code that is not here is shown exactly as the backend sent it: never
// invent a meaning for an unknown code.
import { es } from './es.js';

export const MOTIVOS_QC: Readonly<Record<string, string>> = {
  archivo_ilegible: 'No se pudo leer un archivo guardado.',
  archivo_tamano_distinto: 'El tamaño de un archivo guardado no coincide con el registrado.',
  archivo_hash_distinto: 'El contenido de un archivo guardado cambió respecto al registrado.',
  hash_pieza_distinto: 'El hash de la pieza recalculado no coincide con el de la producción.',
  imagen_formato: 'El formato real de una imagen no es el esperado.',
  imagen_dimensiones: 'Las dimensiones de una imagen no son las exigidas para la red y el formato.',
  imagen_no_srgb: 'Una imagen no está en espacio de color sRGB.',
  imagen_metadatos: 'Una imagen conserva metadatos (EXIF, XMP, IPTC o ICC).',
  imagen_tamano_maximo: 'Una imagen supera el tamaño máximo permitido.',
  texto_alternativo_falta: 'Falta el texto alternativo de una imagen.',
  reel_formato: 'El video no cumple el formato exigido (contenedor, códecs, fps, color o audio).',
  reel_etiquetas: 'El video trae etiquetas de metadatos no permitidas.',
  reel_ubicacion_atomo: 'El video contiene metadatos de ubicación.',
  reel_tamano_maximo: 'El video supera el tamaño máximo permitido.',
  reel_duracion: 'La duración del video está fuera del rango de 15 a 30 segundos.',
  plantilla_invalida: 'La plantilla de subtítulos registrada no existe.',
  diapositivas_cantidad: 'La cantidad de diapositivas o escenas no es la permitida para el formato.',
  texto_publicacion_largo: 'El texto de la publicación es demasiado largo.',
  hashtags_cantidad: 'Hay más hashtags de los permitidos.',
  hashtags_forma: 'Algún hashtag no tiene una forma válida.',
  texto_alternativo_largo: 'Algún texto alternativo es demasiado largo.',
  ubicacion_larga: 'La ubicación es demasiado larga.',
  regla_prohibida_palabra: 'Un texto contiene una palabra prohibida por el cliente.',
  regla_prohibida_promesa: 'Un texto contiene una promesa prohibida por el cliente.',
  regla_prohibida_tema: 'Un texto toca un tema prohibido por el cliente.',
  cifra_libre: 'Hay una cifra, precio, horario o promoción que no viene de un hecho verificado.',
  hecho_texto_cambiado: 'El texto de un hecho verificado cambió después de escribir la pieza.',
  hecho_no_vigente: 'Un hecho verificado citado no está vigente.',
  media_no_usable: 'Una fuente de media ya no se puede usar (derechos o autorizaciones).',
  fuente_ia_no_permitida: 'Una fuente no es media real de la biblioteca del cliente.',
  toma_faltante: 'Hay una toma sin media real.',
  fecha_pasada: 'La fecha y hora de publicación ya pasó.',
  horario_vetado: 'La fecha y hora de publicación cae en un horario vetado del cliente.',
  programacion_proxima: 'La publicación está programada para dentro de menos de 30 minutos.',
  marca_contraste: 'El contraste entre el texto y el fondo es menor que 4.5:1.',
  marca_fuente_no_permitida: 'La fuente de los textos no está entre las permitidas.',
  marca_glifos_no_soportados: 'Un texto en pantalla usa caracteres que la fuente no puede dibujar.',
  marca_colores_respaldo: 'El perfil de marca no tiene colores útiles; se usaron los de respaldo.',
  voz_audio_ausente: 'La pieza tiene locución, pero el audio del video está en silencio.',
  voz_volumen_fuera_de_rango: 'El volumen de la locución está fuera del rango permitido (sonoridad o pico).',
  voz_subtitulos_ausentes: 'La pieza tiene locución, pero no tiene subtítulos palabra por palabra.',
  voz_etiqueta_ia_pendiente: 'La pieza lleva audio sintético: debe publicarse con la etiqueta de contenido con IA (por confirmar con cada red).',
  voz_omitida_sin_plantilla: 'El cliente tiene voz configurada, pero el reel salió sin locución porque no se pudo usar una plantilla de subtítulos.',
};

export function etiquetaCodigoQc(codigo: string): string {
  const label = MOTIVOS_QC[codigo];
  if (label !== undefined) return label;
  const trimmed = codigo.trim();
  return trimmed ? trimmed : es.common.notAvailable;
}
