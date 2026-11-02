export * from './errors.js';
export { prepararTextoLocucion, normalizarTextoLocucion, type EntradaTextoLocucion, type TextoLocucion } from './textoLocucion.js';
export {
  alineacionAPalabras,
  alineacionDesdeSegundos,
  type AlineacionCaracteres,
  type AlineacionEnSegundos,
} from './alineacion.js';
export { comprobarAjusteEscena, comprobarAjusteReel, MARGENES_VOZ, type AjusteReel, type EscenaDeReel, type MargenesVoz } from './ajuste.js';
export { claveCache, CLAVE_CACHE_VERSION, VELOCIDAD_MAX, VELOCIDAD_MIN, type AjustesVoz, type EntradaClaveCache } from './claveCache.js';
