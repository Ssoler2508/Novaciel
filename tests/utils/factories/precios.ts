import type { Db } from '../../../src/db/types.js';
import { createUsuario } from './usuarios.js';
import { uniqueSuffix } from './unique.js';

export interface PrecioModeloRow {
  id: string;
  proveedor: string;
  modelo: string;
  precio_entrada_por_millon: string;
  precio_salida_por_millon: string;
  vigente_desde: Date;
  nota: string | null;
  creado_por: string;
  creado_en: Date;
}

export interface PrecioModeloOverrides {
  proveedor?: string;
  modelo?: string;
  /** USD per million tokens, as a decimal string. These are obviously fake test values. */
  precioEntrada?: string;
  precioSalida?: string;
  /** Omit to use the column default (now()). */
  vigenteDesde?: Date;
  nota?: string | null;
  creadoPor?: string;
}

/** Inserts a price with plain SQL (no permission check, no audit). Unique provider/model by default. */
export async function createPrecioModelo(db: Db, overrides: PrecioModeloOverrides = {}): Promise<PrecioModeloRow> {
  const suffix = uniqueSuffix();
  const creadoPor = overrides.creadoPor ?? (await createUsuario(db)).id;
  const { rows } = await db.query<PrecioModeloRow>(
    `INSERT INTO precios_modelos
       (proveedor, modelo, precio_entrada_por_millon, precio_salida_por_millon, vigente_desde, nota, creado_por)
     VALUES ($1, $2, $3, $4, coalesce($5, now()), $6, $7)
     RETURNING id, proveedor, modelo, precio_entrada_por_millon::text AS precio_entrada_por_millon,
       precio_salida_por_millon::text AS precio_salida_por_millon, vigente_desde, nota, creado_por, creado_en`,
    [
      overrides.proveedor ?? `fake_provider_${suffix}`,
      overrides.modelo ?? `fake-model-${suffix}`,
      overrides.precioEntrada ?? '1.000000',
      overrides.precioSalida ?? '2.000000',
      overrides.vigenteDesde ?? null,
      overrides.nota ?? null,
      creadoPor,
    ],
  );
  return rows[0]!;
}
