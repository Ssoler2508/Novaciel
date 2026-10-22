import { describe, expect, it } from 'vitest';
import { estadoAprobacion } from './estadoAprobacion.js';
import type { ProduccionActual, RegistroAprobacion } from './types.js';

const hash = (byte: number) => new Uint8Array(32).fill(byte);
const ACTUAL: ProduccionActual = { id: 'prod-2', version: 2, hashVersion: 'np1', hashPieza: hash(2) };

/** A record of the current production unless `over` says otherwise. */
function r(
  seq: number | string | bigint,
  nivel: RegistroAprobacion['nivel'],
  decision: RegistroAprobacion['decision'],
  over: Partial<RegistroAprobacion> = {},
): RegistroAprobacion {
  return { seq, produccionId: 'prod-2', version: 2, hashVersion: 'np1', hashPieza: hash(2), nivel, decision, ...over };
}
const OLD_VERSION = { produccionId: 'prod-1', version: 1, hashPieza: hash(1) };
const OTHER_HASH = { hashPieza: hash(9) };

describe('estadoAprobacion', () => {
  const cases: [string, RegistroAprobacion[], object][] = [
    ['no records', [], { estado: 'pendiente_interno' }],
    ['internal approval only', [r(1, 'interno', 'aprobada')], { estado: 'pendiente_cliente', internoSeq: 1n }],
    ['client approval only (bypassing the order): nothing counts', [r(1, 'cliente', 'aprobada')], { estado: 'pendiente_interno' }],
    ['internal then client', [r(1, 'interno', 'aprobada'), r(2, 'cliente', 'aprobada')], { estado: 'aprobada', internoSeq: 1n, clienteSeq: 2n }],
    [
      'a client approval OLDER than the internal one does not count',
      [r(1, 'cliente', 'aprobada'), r(2, 'interno', 'aprobada')],
      { estado: 'pendiente_cliente', internoSeq: 2n },
    ],
    ['client change request after the internal approval', [r(1, 'interno', 'aprobada'), r(2, 'cliente', 'cambios')], { estado: 'cambios_pedidos', ronda: 1 }],
    ['internal change request alone: changes pending, but round 0', [r(1, 'interno', 'cambios')], { estado: 'cambios_pedidos', ronda: 0 }],
    [
      'approve again after a change request: back to the client',
      [r(1, 'interno', 'aprobada'), r(2, 'cliente', 'cambios'), r(3, 'interno', 'aprobada')],
      { estado: 'pendiente_cliente', internoSeq: 3n },
    ],
    [
      'approved after a change request and a new internal approval',
      [r(1, 'interno', 'aprobada'), r(2, 'cliente', 'cambios'), r(3, 'interno', 'aprobada'), r(4, 'cliente', 'aprobada')],
      { estado: 'aprobada', internoSeq: 3n, clienteSeq: 4n },
    ],
    [
      'a change request after the client approval voids it',
      [r(1, 'interno', 'aprobada'), r(2, 'cliente', 'aprobada'), r(3, 'cliente', 'cambios')],
      { estado: 'cambios_pedidos', ronda: 1 },
    ],
    ['client rejection', [r(1, 'interno', 'aprobada'), r(2, 'cliente', 'rechazada')], { estado: 'rechazada' }],
    [
      'a rejection wins over everything else',
      [r(1, 'interno', 'aprobada'), r(2, 'cliente', 'aprobada'), r(3, 'cliente', 'rechazada')],
      { estado: 'rechazada' },
    ],
    [
      'both approvals of an OLD version count for nothing',
      [r(1, 'interno', 'aprobada', OLD_VERSION), r(2, 'cliente', 'aprobada', OLD_VERSION)],
      { estado: 'pendiente_interno' },
    ],
    [
      'old approvals do not help a new internal-only approval',
      [r(1, 'interno', 'aprobada', OLD_VERSION), r(2, 'cliente', 'aprobada', OLD_VERSION), r(3, 'interno', 'aprobada')],
      { estado: 'pendiente_cliente', internoSeq: 3n },
    ],
    [
      'same id and version but another hash',
      [r(1, 'interno', 'aprobada', OTHER_HASH), r(2, 'cliente', 'aprobada', OTHER_HASH)],
      { estado: 'pendiente_interno' },
    ],
    [
      'same hash bytes but another hash version',
      [r(1, 'interno', 'aprobada', { hashVersion: 'np2' }), r(2, 'cliente', 'aprobada', { hashVersion: 'np2' })],
      { estado: 'pendiente_interno' },
    ],
    [
      'same version and hash but another production id',
      [r(1, 'interno', 'aprobada', { produccionId: 'prod-x' }), r(2, 'cliente', 'aprobada', { produccionId: 'prod-x' })],
      { estado: 'pendiente_interno' },
    ],
    [
      'a change request of an old version is not pending, but still counts as a client round',
      [r(1, 'cliente', 'cambios', OLD_VERSION), r(2, 'interno', 'aprobada')],
      { estado: 'pendiente_cliente', internoSeq: 2n },
    ],
    [
      'the round number counts client requests over all productions',
      [r(1, 'cliente', 'cambios', OLD_VERSION), r(2, 'interno', 'cambios', OLD_VERSION), r(3, 'cliente', 'cambios')],
      { estado: 'cambios_pedidos', ronda: 2 },
    ],
    [
      '2 internal requests + 1 client request = round 1',
      [r(1, 'interno', 'cambios'), r(2, 'interno', 'cambios'), r(3, 'cliente', 'cambios')],
      { estado: 'cambios_pedidos', ronda: 1 },
    ],
    [
      '3 client requests = round 3',
      [r(1, 'cliente', 'cambios'), r(2, 'cliente', 'cambios'), r(3, 'cliente', 'cambios')],
      { estado: 'cambios_pedidos', ronda: 3 },
    ],
  ];

  it.each(cases)('%s', (_name, records, expected) => {
    expect(estadoAprobacion(ACTUAL, records)).toEqual(expected);
  });

  it('orders by seq, not by array order or by timestamp: shuffling the input gives the same answer', () => {
    for (const [, records, expected] of cases) {
      expect(estadoAprobacion(ACTUAL, [...records].reverse())).toEqual(expected);
      expect(estadoAprobacion(ACTUAL, [...records.slice(1), ...records.slice(0, 1)])).toEqual(expected);
    }
  });

  it('accepts seq as a string (the pg bigint), a number or a bigint, and compares them as numbers, not text', () => {
    const records = [r('9', 'interno', 'aprobada'), r('10', 'cliente', 'aprobada')]; // '10' < '9' as text
    expect(estadoAprobacion(ACTUAL, records)).toEqual({ estado: 'aprobada', internoSeq: 9n, clienteSeq: 10n });
    expect(estadoAprobacion(ACTUAL, [r(9n, 'interno', 'aprobada'), r(10, 'cliente', 'aprobada')])).toMatchObject({ estado: 'aprobada' });
  });

  it('compares hashes by bytes, not by object identity', () => {
    const records = [
      r(1, 'interno', 'aprobada', { hashPieza: Uint8Array.from(hash(2)) }),
      r(2, 'cliente', 'aprobada', { hashPieza: Uint8Array.from(hash(2)) }),
    ];
    expect(estadoAprobacion(ACTUAL, records)).toMatchObject({ estado: 'aprobada' });
    expect(estadoAprobacion({ ...ACTUAL, hashPieza: new Uint8Array(31).fill(2) }, records)).toEqual({ estado: 'pendiente_interno' });
  });

  it('does not change its input', () => {
    const records = [r(2, 'cliente', 'aprobada'), r(1, 'interno', 'aprobada')];
    const copy = structuredClone(records);
    estadoAprobacion(ACTUAL, records);
    expect(records).toEqual(copy);
  });
});
