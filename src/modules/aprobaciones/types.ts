/** `seq` comes from a bigint column: pg returns it as a string. */
export type Seq = string | number | bigint;

/** The columns of an `aprobaciones` row that the rules read. */
export interface RegistroAprobacion {
  seq: Seq;
  produccionId: string;
  version: number;
  hashVersion: string;
  hashPieza: Uint8Array;
  nivel: 'interno' | 'cliente';
  decision: 'aprobada' | 'cambios' | 'rechazada';
}

/** The current production of the piece: the only one a decision can be about. */
export interface ProduccionActual {
  id: string;
  version: number;
  hashVersion: string;
  hashPieza: Uint8Array;
}
