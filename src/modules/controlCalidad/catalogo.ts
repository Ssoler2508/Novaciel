import type { Severidad } from './tipos.js';

// The catalogue of quality-control checks: one stable code each, its severity and a short human reason
// in Spanish (for the reviewer and, later, the dashboard). The reasons are fixed phrases: they never
// carry text of the client. Sources and the VERIFY values are listed in the Step 8 ADR.

export const CODIGOS_QC = [
  // Files (checkpoint C reads them back from storage)
  'archivo_ilegible',
  'archivo_tamano_distinto',
  'archivo_hash_distinto',
  'hash_pieza_distinto',
  // Images
  'imagen_formato',
  'imagen_dimensiones',
  'imagen_no_srgb',
  'imagen_metadatos',
  'imagen_tamano_maximo',
  'texto_alternativo_falta',
  // Reels
  'reel_formato',
  'reel_etiquetas',
  'reel_ubicacion_atomo',
  'reel_tamano_maximo',
  'reel_duracion',
  'plantilla_invalida',
  // Format rules
  'diapositivas_cantidad',
  'texto_publicacion_largo',
  'hashtags_cantidad',
  'hashtags_forma',
  'texto_alternativo_largo',
  'ubicacion_larga',
  // Banned rules
  'regla_prohibida_palabra',
  'regla_prohibida_promesa',
  'regla_prohibida_tema',
  // Rule 2: figures come from verified facts
  'cifra_libre',
  'hecho_texto_cambiado',
  'hecho_no_vigente',
  // Media
  'media_no_usable',
  'fuente_ia_no_permitida',
  'toma_faltante',
  // Schedule
  'fecha_pasada',
  'horario_vetado',
  'programacion_proxima',
  // Brand
  'marca_contraste',
  'marca_fuente_no_permitida',
  'marca_glifos_no_soportados',
  'marca_colores_respaldo',
] as const;

export type CodigoQC = (typeof CODIGOS_QC)[number];

/** Exhaustive at compile time: a code without an entry here does not compile. */
export const CATALOGO: Record<CodigoQC, { severidad: Severidad; motivo: string }> = {
  archivo_ilegible: { severidad: 'bloqueante', motivo: 'No se pudo leer un archivo guardado.' },
  archivo_tamano_distinto: { severidad: 'bloqueante', motivo: 'El tamaño de un archivo guardado no coincide con el registrado.' },
  archivo_hash_distinto: { severidad: 'bloqueante', motivo: 'El contenido de un archivo guardado cambió respecto al registrado.' },
  hash_pieza_distinto: { severidad: 'bloqueante', motivo: 'El hash de la pieza recalculado no coincide con el de la producción.' },
  imagen_formato: { severidad: 'bloqueante', motivo: 'El formato real de una imagen no es el esperado.' },
  imagen_dimensiones: { severidad: 'bloqueante', motivo: 'Las dimensiones de una imagen no son las exigidas para la red y el formato.' },
  imagen_no_srgb: { severidad: 'bloqueante', motivo: 'Una imagen no está en espacio de color sRGB.' },
  imagen_metadatos: { severidad: 'bloqueante', motivo: 'Una imagen conserva metadatos (EXIF, XMP, IPTC o ICC).' },
  imagen_tamano_maximo: { severidad: 'bloqueante', motivo: 'Una imagen supera el tamaño máximo permitido.' },
  texto_alternativo_falta: { severidad: 'bloqueante', motivo: 'Falta el texto alternativo de una imagen.' },
  reel_formato: { severidad: 'bloqueante', motivo: 'El video no cumple el formato exigido (contenedor, códecs, fps, color o audio).' },
  reel_etiquetas: { severidad: 'bloqueante', motivo: 'El video trae etiquetas de metadatos no permitidas.' },
  reel_ubicacion_atomo: { severidad: 'bloqueante', motivo: 'El video contiene metadatos de ubicación.' },
  reel_tamano_maximo: { severidad: 'bloqueante', motivo: 'El video supera el tamaño máximo permitido.' },
  reel_duracion: { severidad: 'bloqueante', motivo: 'La duración del video está fuera del rango de 15 a 30 segundos.' },
  plantilla_invalida: { severidad: 'bloqueante', motivo: 'La plantilla de subtítulos registrada no existe.' },
  diapositivas_cantidad: { severidad: 'bloqueante', motivo: 'La cantidad de diapositivas o escenas no es la permitida para el formato.' },
  texto_publicacion_largo: { severidad: 'bloqueante', motivo: 'El texto de la publicación es demasiado largo.' },
  hashtags_cantidad: { severidad: 'bloqueante', motivo: 'Hay más hashtags de los permitidos.' },
  hashtags_forma: { severidad: 'bloqueante', motivo: 'Algún hashtag no tiene una forma válida.' },
  texto_alternativo_largo: { severidad: 'bloqueante', motivo: 'Algún texto alternativo es demasiado largo.' },
  ubicacion_larga: { severidad: 'bloqueante', motivo: 'La ubicación es demasiado larga.' },
  regla_prohibida_palabra: { severidad: 'bloqueante', motivo: 'Un texto contiene una palabra prohibida por el cliente.' },
  regla_prohibida_promesa: { severidad: 'bloqueante', motivo: 'Un texto contiene una promesa prohibida por el cliente.' },
  regla_prohibida_tema: { severidad: 'bloqueante', motivo: 'Un texto toca un tema prohibido por el cliente.' },
  cifra_libre: { severidad: 'bloqueante', motivo: 'Hay una cifra, precio, horario o promoción que no viene de un hecho verificado.' },
  hecho_texto_cambiado: { severidad: 'bloqueante', motivo: 'El texto de un hecho verificado cambió después de escribir la pieza.' },
  hecho_no_vigente: { severidad: 'bloqueante', motivo: 'Un hecho verificado citado no está vigente.' },
  media_no_usable: { severidad: 'bloqueante', motivo: 'Una fuente de media ya no se puede usar (derechos o autorizaciones).' },
  fuente_ia_no_permitida: { severidad: 'bloqueante', motivo: 'Una fuente no es media real de la biblioteca del cliente.' },
  toma_faltante: { severidad: 'bloqueante', motivo: 'Hay una toma sin media real.' },
  fecha_pasada: { severidad: 'bloqueante', motivo: 'La fecha y hora de publicación ya pasó.' },
  horario_vetado: { severidad: 'bloqueante', motivo: 'La fecha y hora de publicación cae en un horario vetado del cliente.' },
  programacion_proxima: { severidad: 'advertencia', motivo: 'La publicación está programada para dentro de menos de 30 minutos.' },
  marca_contraste: { severidad: 'bloqueante', motivo: 'El contraste entre el texto y el fondo es menor que 4.5:1.' },
  marca_fuente_no_permitida: { severidad: 'bloqueante', motivo: 'La fuente de los textos no está entre las permitidas.' },
  marca_glifos_no_soportados: { severidad: 'bloqueante', motivo: 'Un texto en pantalla usa caracteres que la fuente no puede dibujar.' },
  marca_colores_respaldo: { severidad: 'advertencia', motivo: 'El perfil de marca no tiene colores útiles; se usaron los de respaldo.' },
};
