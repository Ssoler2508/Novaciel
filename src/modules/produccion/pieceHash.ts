import { createHash } from 'node:crypto';
import { REDES } from '../planificador/types.js';
import { PieceHashInputError } from './errors.js';

// The piece-level hash, version np1: EXACTLY the definition frozen in docs/HASH_PIEZA_NP1.md. Pure:
// no I/O, no clock, it never changes its input. Steps 9 (approval) and 10 (publishing) recompute it
// from the stored data, so the serialization must never change in place: a change is a new version
// (np2), a new function and a new tag in producciones.hash_version.

export const HASH_VERSION = 'np1';
const DOMAIN = `novaciel/pieza/${HASH_VERSION}`;
const FILE_HASH_BYTES = 32;

export interface PieceHashInput {
  /** The target network. */
  red: string;
  /** The SHA-256 of each final file, 32 raw bytes each, in file order (orden ascending). */
  archivos: readonly Uint8Array[];
  /** The caption, as published. */
  textoPublicacion: string;
  /** The hashtags exactly as published, including the leading '#', in published order. */
  hashtags: readonly string[];
  /** The alt texts: one per file, in file order. */
  textosAlternativos: readonly string[];
  /** The location. Absent (undefined, null) is the empty string. */
  ubicacion?: string | null;
}

function uint32(n: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n);
  return out;
}

// A lone surrogate is the only thing \p{Cs} matches under the u flag (a valid pair is one code point).
const LONE_SURROGATE = /\p{Cs}/u;

/** str(s): NFC, UTF-8, preceded by the byte length as uint32 big-endian. Nothing else is touched. */
function str(s: string): Buffer {
  if (LONE_SURROGATE.test(s)) throw new PieceHashInputError('texto_mal_formado');
  const bytes = Buffer.from(s.normalize('NFC'), 'utf8');
  return Buffer.concat([uint32(bytes.length), bytes]);
}

/** list(items): the number of items as uint32 big-endian, then each item in order. */
function list(items: readonly Buffer[]): Buffer {
  return Buffer.concat([uint32(items.length), ...items]);
}

/** The 32-byte np1 hash of a piece. Throws PieceHashInputError (a reason code, never content). */
export function computePieceHash(input: PieceHashInput): Buffer {
  if (!(REDES as readonly string[]).includes(input.red)) throw new PieceHashInputError('red_invalida');
  if (input.archivos.length === 0) throw new PieceHashInputError('sin_archivos');
  if (input.archivos.some((hash) => hash.length !== FILE_HASH_BYTES)) throw new PieceHashInputError('hash_de_archivo_invalido');
  if (input.textosAlternativos.length !== input.archivos.length) throw new PieceHashInputError('textos_alternativos_distinto_de_archivos');

  const bytes = Buffer.concat([
    str(DOMAIN),
    str(input.red),
    list(input.archivos.map((hash) => Buffer.from(hash))),
    str(input.textoPublicacion),
    list(input.hashtags.map(str)),
    list(input.textosAlternativos.map(str)),
    str(input.ubicacion ?? ''),
  ]);
  return createHash('sha256').update(bytes).digest();
}

/** The same hash as lower-case hex (how it is shown). */
export function computePieceHashHex(input: PieceHashInput): string {
  return computePieceHash(input).toString('hex');
}
