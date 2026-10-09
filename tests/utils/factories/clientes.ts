import type { Db } from '../../../src/db/types.js';
import { uniqueSuffix } from './unique.js';

export interface ClienteRow {
  id: string;
  nombre_comercial: string;
  razon_social: string | null;
  estado: 'en_onboarding' | 'activo' | 'en_pausa';
  creado_en: Date;
}

export async function createCliente(db: Db, overrides: Partial<Omit<ClienteRow, 'id' | 'creado_en'>> = {}): Promise<ClienteRow> {
  const suffix = uniqueSuffix();
  const row = {
    nombre_comercial: `Cliente Ficticio ${suffix}`,
    razon_social: `Cliente Ficticio ${suffix} SAS`,
    estado: 'en_onboarding',
    ...overrides,
  };
  const { rows } = await db.query<ClienteRow>(
    `INSERT INTO clientes (nombre_comercial, razon_social, estado) VALUES ($1, $2, $3) RETURNING *`,
    [row.nombre_comercial, row.razon_social, row.estado],
  );
  return rows[0]!;
}
