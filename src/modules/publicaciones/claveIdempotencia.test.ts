import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ClaveIdempotenciaEntradaError } from './errors.js';
import { CLAVE_IDEMPOTENCIA_VERSION, claveIdempotencia } from './claveIdempotencia.js';

const PIEZA = '11111111-1111-4111-8111-111111111111';
const PRODUCCION = '22222222-2222-4222-8222-222222222222';
const HASH = new Uint8Array(32).fill(7);

function str(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const n = Buffer.alloc(4);
  n.writeUInt32BE(b.length);
  return Buffer.concat([n, b]);
}

describe('claveIdempotencia (pi1)', () => {
  it('matches an independent implementation of the documented serialization', () => {
    const esperado = createHash('sha256')
      .update(Buffer.concat([str('novaciel/publicacion/pi1'), str(PIEZA), str(PRODUCCION), Buffer.from(HASH)]))
      .digest('hex');
    expect(claveIdempotencia({ piezaId: PIEZA, produccionId: PRODUCCION, hashPieza: HASH })).toBe(`pi1:${esperado}`);
  });

  it('is stable, versioned and short enough for the column', () => {
    const a = claveIdempotencia({ piezaId: PIEZA, produccionId: PRODUCCION, hashPieza: HASH });
    const b = claveIdempotencia({ piezaId: PIEZA, produccionId: PRODUCCION, hashPieza: Uint8Array.from(HASH) });
    expect(a).toBe(b);
    expect(CLAVE_IDEMPOTENCIA_VERSION).toBe('pi1');
    expect(a).toMatch(/^pi1:[0-9a-f]{64}$/);
    expect(a.length).toBeLessThanOrEqual(200);
  });

  it('ignores the case of the ids', () => {
    const a = claveIdempotencia({ piezaId: PIEZA, produccionId: PRODUCCION, hashPieza: HASH });
    const b = claveIdempotencia({ piezaId: PIEZA.toUpperCase(), produccionId: PRODUCCION.toUpperCase(), hashPieza: HASH });
    expect(b).toBe(a);
  });

  it('changes with the piece, the production and any byte of the hash', () => {
    const base = claveIdempotencia({ piezaId: PIEZA, produccionId: PRODUCCION, hashPieza: HASH });
    const vistas = new Set([base]);
    vistas.add(claveIdempotencia({ piezaId: '33333333-3333-4333-8333-333333333333', produccionId: PRODUCCION, hashPieza: HASH }));
    vistas.add(claveIdempotencia({ piezaId: PIEZA, produccionId: '33333333-3333-4333-8333-333333333333', hashPieza: HASH }));
    for (let i = 0; i < 32; i++) {
      const otro = Uint8Array.from(HASH);
      otro[i] = 8;
      vistas.add(claveIdempotencia({ piezaId: PIEZA, produccionId: PRODUCCION, hashPieza: otro }));
    }
    expect(vistas.size).toBe(1 + 2 + 32);
  });

  it('does not confuse swapping the piece and the production', () => {
    const a = claveIdempotencia({ piezaId: PIEZA, produccionId: PRODUCCION, hashPieza: HASH });
    const b = claveIdempotencia({ piezaId: PRODUCCION, produccionId: PIEZA, hashPieza: HASH });
    expect(a).not.toBe(b);
  });

  it('rejects malformed input with a reason code', () => {
    const reason = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as ClaveIdempotenciaEntradaError).reason;
      }
      return null;
    };
    expect(reason(() => claveIdempotencia({ piezaId: 'x', produccionId: PRODUCCION, hashPieza: HASH }))).toBe('pieza_id_invalido');
    expect(reason(() => claveIdempotencia({ piezaId: PIEZA, produccionId: '', hashPieza: HASH }))).toBe('produccion_id_invalido');
    expect(reason(() => claveIdempotencia({ piezaId: PIEZA, produccionId: PRODUCCION, hashPieza: new Uint8Array(31) }))).toBe('hash_pieza_invalido');
    expect(reason(() => claveIdempotencia({ piezaId: PIEZA, produccionId: PRODUCCION, hashPieza: 'abc' as unknown as Uint8Array }))).toBe('hash_pieza_invalido');
  });
});
