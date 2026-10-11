import type { Db } from '../../../src/db/types.js';
import { createCliente } from './clientes.js';
import { createUsuario } from './usuarios.js';
import { uniqueSuffix } from './unique.js';

export interface HechoVerificadoRow {
  id: string;
  cliente_id: string;
  tipo: string;
  enunciado: string;
  fuente: string;
  verificado_por: string;
  vigente_desde: Date;
  vigente_hasta: Date | null;
  creado_en: Date;
}

export interface HechoVerificadoOverrides {
  clienteId?: string;
  verificadoPor?: string;
  tipo?: string;
  enunciado?: string;
  fuente?: string;
  vigenteDesde?: Date;
  vigenteHasta?: Date | null;
  /** Creates the fact already expired (valid from 10 days ago until yesterday). */
  expired?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createHechoVerificado(db: Db, overrides: HechoVerificadoOverrides = {}): Promise<HechoVerificadoRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const verificadoPor = overrides.verificadoPor ?? (await createUsuario(db)).id;
  const suffix = uniqueSuffix();
  const now = Date.now();
  const desde = overrides.vigenteDesde ?? (overrides.expired ? new Date(now - 10 * DAY_MS) : new Date(now - DAY_MS));
  const hasta =
    overrides.vigenteHasta !== undefined ? overrides.vigenteHasta : overrides.expired ? new Date(now - DAY_MS) : null;
  const { rows } = await db.query<HechoVerificadoRow>(
    `INSERT INTO hechos_verificados (cliente_id, tipo, enunciado, fuente, verificado_por, vigente_desde, vigente_hasta)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      clienteId,
      overrides.tipo ?? 'otro',
      overrides.enunciado ?? `Hecho ficticio ${suffix}`,
      overrides.fuente ?? `Fuente ficticia ${suffix}`,
      verificadoPor,
      desde,
      hasta,
    ],
  );
  return rows[0]!;
}
