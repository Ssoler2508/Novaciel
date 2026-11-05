import { createHash } from 'node:crypto';
import { ClaveIdempotenciaEntradaError } from './errors.js';

// The idempotency key of a publication (Step 10): SHA-256 of a canonical, versioned serialization of the
// piece, the exact production and its np1 hash. PURE. Same shape of idea as np1 and lc1: a domain tag,
// strings as NFC UTF-8 with a uint32 big-endian length, raw bytes for the hash.
//
// pi1 = str("novaciel/publicacion/pi1") str(piezaId) str(produccionId) bytes32(hash_pieza)
//
// The client id is not part of it: the database key is UNIQUE (cliente_id, clave_idempotencia, ...), so the
// same ids under two clients are two rows. A change of the serialization is a NEW version (pi2) and a new
// function: old keys stay verifiable. The text form is "pi1:" + 64 hex characters (under the 200 of the CHECK).

export const CLAVE_IDEMPOTENCIA_VERSION = 'pi1';
const DOMAIN = `novaciel/publicacion/${CLAVE_IDEMPOTENCIA_VERSION}`;
const HASH_PIEZA_BYTES = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EntradaClaveIdempotencia {
  piezaId: string;
  produccionId: string;
  /** `producciones.hash_pieza` (np1): 32 raw bytes. */
  hashPieza: Uint8Array;
}

function str(s: string): Buffer {
  const bytes = Buffer.from(s.normalize('NFC'), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** The key as text: `pi1:<sha256 hex>`. Throws ClaveIdempotenciaEntradaError (a reason code, never the value). */
export function claveIdempotencia(input: EntradaClaveIdempotencia): string {
  if (typeof input.piezaId !== 'string' || !UUID_RE.test(input.piezaId)) throw new ClaveIdempotenciaEntradaError('pieza_id_invalido');
  if (typeof input.produccionId !== 'string' || !UUID_RE.test(input.produccionId)) throw new ClaveIdempotenciaEntradaError('produccion_id_invalido');
  if (!(input.hashPieza instanceof Uint8Array) || input.hashPieza.length !== HASH_PIEZA_BYTES) throw new ClaveIdempotenciaEntradaError('hash_pieza_invalido');

  const bytes = Buffer.concat([
    str(DOMAIN),
    str(input.piezaId.toLowerCase()),
    str(input.produccionId.toLowerCase()),
    Buffer.from(input.hashPieza),
  ]);
  return `${CLAVE_IDEMPOTENCIA_VERSION}:${createHash('sha256').update(bytes).digest('hex')}`;
}
