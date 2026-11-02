import { createHash } from 'node:crypto';
import { LocucionEntradaInvalidaError } from './errors.js';

// The cache key of a voice-over (Step 7d): SHA-256 of a canonical, versioned serialization of everything
// that changes the audio. Same shape of idea as np1 (docs/HASH_PIEZA_NP1.md): a domain tag, strings as
// NFC UTF-8 with a uint32 big-endian length, numbers as IEEE-754 float64 big-endian. PURE.
//
// lc1 =  str("novaciel/locucion/lc1") str(texto) str(vozId) str(modeloId) str(formato)
//        f64(estabilidad) f64(similitud) f64(estilo) f64(velocidad) u8(refuerzoVoz) str(idioma o "")
// A change of the serialization is a NEW version (lc2) and a new function: old keys stay verifiable.
// The key is per client in the database (UNIQUE (cliente_id, clave_cache)), so the same text for two
// clients is two rows and the cache is never shared between clients.

export const CLAVE_CACHE_VERSION = 'lc1';
const DOMAIN = `novaciel/locucion/${CLAVE_CACHE_VERSION}`;

export interface AjustesVoz {
  /** 0 to 1. */
  estabilidad: number;
  /** 0 to 1. */
  similitud: number;
  /** 0 to 1. */
  estilo: number;
  velocidad: number;
  refuerzoVoz: boolean;
  /** ISO 639-1 (two lowercase letters), or null when the model does not take a language. */
  idioma: string | null;
}

/** Accepted speed range (VERIFY against the provider's documentation). */
export const VELOCIDAD_MIN = 0.7;
export const VELOCIDAD_MAX = 1.2;

export interface EntradaClaveCache {
  /** The prepared text (prepararTextoLocucion). */
  texto: string;
  vozId: string;
  modeloId: string;
  ajustes: AjustesVoz;
  /** The provider's output format, for example the one the adapter fixes. */
  formato: string;
}

const LONE_SURROGATE = /\p{Cs}/u;

function str(valor: string): Buffer {
  if (typeof valor !== 'string' || LONE_SURROGATE.test(valor)) throw new LocucionEntradaInvalidaError('texto_mal_formado');
  const bytes = Buffer.from(valor.normalize('NFC'), 'utf8');
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(bytes.length);
  return Buffer.concat([largo, bytes]);
}

function noVacio(valor: string): string {
  if (typeof valor !== 'string' || valor.trim() === '') throw new LocucionEntradaInvalidaError('campo_vacio');
  return valor;
}

function f64(valor: number, min: number, max: number): Buffer {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < min || valor > max) throw new LocucionEntradaInvalidaError('ajuste_fuera_de_rango');
  const out = Buffer.alloc(8);
  out.writeDoubleBE(valor === 0 ? 0 : valor); // -0 and 0 are the same setting
  return out;
}

/** The 64-character lowercase hex SHA-256 of the lc1 serialization. */
export function claveCache(entrada: EntradaClaveCache): string {
  const { ajustes } = entrada;
  if (ajustes.idioma !== null && !/^[a-z]{2}$/.test(ajustes.idioma)) throw new LocucionEntradaInvalidaError('idioma_invalido');
  if (typeof ajustes.refuerzoVoz !== 'boolean') throw new LocucionEntradaInvalidaError('ajuste_fuera_de_rango');
  const bytes = Buffer.concat([
    str(DOMAIN),
    str(noVacio(entrada.texto)),
    str(noVacio(entrada.vozId)),
    str(noVacio(entrada.modeloId)),
    str(noVacio(entrada.formato)),
    f64(ajustes.estabilidad, 0, 1),
    f64(ajustes.similitud, 0, 1),
    f64(ajustes.estilo, 0, 1),
    f64(ajustes.velocidad, VELOCIDAD_MIN, VELOCIDAD_MAX),
    Buffer.from([ajustes.refuerzoVoz ? 1 : 0]),
    str(ajustes.idioma ?? ''),
  ]);
  return createHash('sha256').update(bytes).digest('hex');
}
