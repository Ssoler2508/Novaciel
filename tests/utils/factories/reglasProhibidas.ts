import type { Db } from '../../../src/db/types.js';
import { createCliente } from './clientes.js';
import { uniqueSuffix } from './unique.js';

export interface ReglaProhibidaRow {
  id: string;
  cliente_id: string;
  tipo: string;
  texto: string;
  motivo: string | null;
  creado_en: Date;
}

export interface ReglaProhibidaOverrides {
  clienteId?: string;
  tipo?: string;
  texto?: string;
  motivo?: string | null;
}

export async function createReglaProhibida(db: Db, overrides: ReglaProhibidaOverrides = {}): Promise<ReglaProhibidaRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const { rows } = await db.query<ReglaProhibidaRow>(
    `INSERT INTO reglas_prohibidas (cliente_id, tipo, texto, motivo) VALUES ($1, $2, $3, $4) RETURNING *`,
    [clienteId, overrides.tipo ?? 'palabra', overrides.texto ?? `palabra-${uniqueSuffix()}`, overrides.motivo ?? null],
  );
  return rows[0]!;
}
