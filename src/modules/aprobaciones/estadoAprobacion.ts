import { rondasDeCambios } from './rondas.js';
import type { ProduccionActual, RegistroAprobacion, Seq } from './types.js';

// Pure. What the records say about the CURRENT production of a piece (ADR-05, decision 4). It follows
// the same order rules as the trigger aprobaciones_before_insert: decisions are ordered by `seq`, never
// by timestamp, and the input order of the array does not matter.

export type EstadoAprobacion =
  | { estado: 'pendiente_interno' }
  | { estado: 'pendiente_cliente'; internoSeq: bigint }
  | { estado: 'cambios_pedidos'; ronda: number }
  | { estado: 'rechazada' }
  | { estado: 'aprobada'; internoSeq: bigint; clienteSeq: bigint };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function esActual(r: RegistroAprobacion, actual: ProduccionActual): boolean {
  return r.produccionId === actual.id && r.version === actual.version && r.hashVersion === actual.hashVersion && sameBytes(r.hashPieza, actual.hashPieza);
}

const seqOf = (r: { seq: Seq }): bigint => BigInt(r.seq);

export function estadoAprobacion(produccionActual: ProduccionActual, registros: readonly RegistroAprobacion[]): EstadoAprobacion {
  // A rejection ends the piece (esperando_aprobacion -> rechazada is terminal), whatever it was about.
  if (registros.some((r) => r.decision === 'rechazada')) return { estado: 'rechazada' };

  // Records of an older production, version or hash count for nothing.
  const actuales = registros.filter((r) => esActual(r, produccionActual));
  const internos = actuales.filter((r) => r.nivel === 'interno' && r.decision === 'aprobada').map(seqOf);
  const internoSeq = internos.length > 0 ? internos.reduce((a, b) => (a > b ? a : b)) : null;
  const cambiosActuales = actuales.filter((r) => r.decision === 'cambios').map(seqOf);
  const hayCambiosVigentes = cambiosActuales.some((s) => internoSeq === null || s > internoSeq);

  if (hayCambiosVigentes) return { estado: 'cambios_pedidos', ronda: rondasDeCambios(registros).rondas };
  if (internoSeq === null) return { estado: 'pendiente_interno' };

  const clientes = actuales.filter((r) => r.nivel === 'cliente' && r.decision === 'aprobada').map(seqOf).filter((s) => s > internoSeq);
  if (clientes.length === 0) return { estado: 'pendiente_cliente', internoSeq };
  return { estado: 'aprobada', internoSeq, clienteSeq: clientes.reduce((a, b) => (a > b ? a : b)) };
}
