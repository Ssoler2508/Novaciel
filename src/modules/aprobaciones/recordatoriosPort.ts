import type { Db } from '../../db/types.js';
import { calcularRecordatorios, REGLAS_RECORDATORIOS, type ReglasRecordatorios, type TipoRecordatorio } from './recordatorios.js';

// The port the approval services use to ask for reminders. The services call it INSIDE their
// transaction, so the reminders are created atomically with the decision that needs them: nothing is
// lost after a crash and nothing is queued when the transaction rolls back.

export type ObjetoAprobacion = 'pieza' | 'plan';

export interface ProgramarAvisosInput {
  clienteId: string;
  tipo: ObjetoAprobacion;
  objetoId: string;
  /** The deadline: the piece's scheduled time, or the earliest scheduled time of the plan's pieces. */
  plazo: Date;
  /** The client's time zone, for the local time of each notice. */
  zona: string;
  /** What the notices are about: the production hash (piece) or the plan fingerprint (plan), lower-case hex. */
  referencia: string;
}

export interface Recordatorios {
  /** Queues the notices still to come; returns their kinds, oldest first. Idempotent for the same input. */
  programar(tx: Db, input: ProgramarAvisosInput, ahora?: Date): Promise<TipoRecordatorio[]>;
  /** Queues the NovaCiel notice for a piece whose 3rd client change request just arrived. */
  escalar(tx: Db, input: { clienteId: string; piezaId: string }): Promise<void>;
}

/** What a reminder job carries. Ids, the kind, the deadline and the reference: no client text. */
export interface PayloadRecordatorio {
  clienteId: string;
  tipo: ObjetoAprobacion;
  objetoId: string;
  aviso: TipoRecordatorio;
  referencia: string;
  /** The deadline the notice was scheduled for, ISO 8601 UTC. If it changed, the job does nothing. */
  plazo: string;
}

export interface AvisoProgramado {
  aviso: TipoRecordatorio;
  cuando: Date;
  singletonKey: string;
  payload: PayloadRecordatorio;
}

/** One notice per (client, kind of object, object, notice, reference, deadline). */
export const singletonKeyAviso = (p: PayloadRecordatorio) => `${p.clienteId}:${p.tipo}:${p.objetoId}:${p.aviso}:${p.referencia}:${Date.parse(p.plazo)}`;
export const singletonKeyEscalada = (clienteId: string, piezaId: string) => `${clienteId}:${piezaId}:escalada`;

/** The notices still to send for an approval target, with their payloads and keys. Pure. */
export function planificarAvisos(input: ProgramarAvisosInput, ahora: Date, reglas: ReglasRecordatorios = REGLAS_RECORDATORIOS): AvisoProgramado[] {
  return calcularRecordatorios(input.plazo, input.zona, reglas, ahora).map((r) => {
    const payload: PayloadRecordatorio = {
      clienteId: input.clienteId,
      tipo: input.tipo,
      objetoId: input.objetoId,
      aviso: r.tipo,
      referencia: input.referencia,
      plazo: input.plazo.toISOString(),
    };
    return { aviso: r.tipo, cuando: r.cuando, singletonKey: singletonKeyAviso(payload), payload };
  });
}

/** Test port: records what the services ask for, queues nothing. */
export class FakeRecordatorios implements Recordatorios {
  readonly programados: { input: ProgramarAvisosInput; avisos: AvisoProgramado[] }[] = [];
  readonly escaladas: { clienteId: string; piezaId: string }[] = [];

  async programar(_tx: Db, input: ProgramarAvisosInput, ahora: Date = new Date()): Promise<TipoRecordatorio[]> {
    const avisos = planificarAvisos(input, ahora);
    this.programados.push({ input, avisos });
    return avisos.map((a) => a.aviso);
  }

  async escalar(_tx: Db, input: { clienteId: string; piezaId: string }): Promise<void> {
    this.escaladas.push({ ...input });
  }
}
