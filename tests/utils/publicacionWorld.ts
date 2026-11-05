import type { Db } from '../../src/db/types.js';
import { FakeStorage } from '../../src/lib/media/storage/fakeStorage.js';
import { registrarDecision } from '../../src/modules/aprobaciones/aprobacionesService.js';
import { programarPieza } from '../../src/modules/publicaciones/programacionService.js';
import { asClienteId, type ClienteId } from '../../src/modules/shared/clienteId.js';
import {
  checkQC,
  createActores,
  createConexionRed,
  createPiezaAprobable,
  createRevisionCalidad,
  moverPieza,
  type Actores,
  type PiezaAprobable,
} from './factories/index.js';

// A piece that reached `programada` through the real services (both approvals, programarPieza), whose time
// has then come (fecha_hora moved to the past with plain SQL), with an active connection of its client.

export interface PiezaProgramada {
  w: PiezaAprobable;
  actores: Actores;
  clienteId: ClienteId;
  storage: FakeStorage;
  /** The plaintext secret of the connection: tests scan logs and errors for it. */
  secreto: string | null;
}

export interface PiezaProgramadaOptions {
  archivos?: number;
  /** The QC report carries the synthetic-voice warning (`voz_etiqueta_ia_pendiente`). */
  conVoz?: boolean;
  /** Default true. */
  conexion?: boolean;
  secreto?: string;
  storage?: FakeStorage;
}

export const SECRETO_FICTICIO = 'sk-ficticio-NUNCA-EN-LOGS-0123456789';

export async function createPiezaProgramada(db: Db, o: PiezaProgramadaOptions = {}): Promise<PiezaProgramada> {
  const storage = o.storage ?? new FakeStorage();
  const w = await createPiezaAprobable(db, storage, {
    ...(o.archivos ? { archivos: o.archivos } : {}),
    ...(o.conVoz ? { estado: 'en_control_calidad' as const } : {}),
  });
  if (o.conVoz) {
    await createRevisionCalidad(db, { piezaId: w.piezaId, checks: [checkQC('voz_etiqueta_ia_pendiente', 'advertencia')] });
    await moverPieza(db, w.piezaId, 'revision_novaciel');
  }
  const actores = await createActores(db, w.clienteId);
  const clienteId = asClienteId(w.clienteId);
  await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
  await registrarDecision({ db }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex });
  await programarPieza({ db, storage }, clienteId, w.piezaId, new Date(Date.now() + 2 * 86_400_000), { tipo: 'sistema' });
  await db.query(`UPDATE piezas SET fecha_hora = now() - interval '1 minute' WHERE id = $1`, [w.piezaId]);
  let secreto: string | null = null;
  if (o.conexion !== false) {
    secreto = o.secreto ?? SECRETO_FICTICIO;
    await createConexionRed(db, { clienteId: w.clienteId, red: 'instagram', secreto });
  }
  return { w, actores, clienteId, storage, secreto };
}
