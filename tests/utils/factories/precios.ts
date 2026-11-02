import type { Db } from '../../../src/db/types.js';
import { createUsuario } from './usuarios.js';
import { uniqueSuffix } from './unique.js';

export interface PrecioModeloRow {
  id: string;
  proveedor: string;
  modelo: string;
  unidad: string;
  precio_entrada_por_millon: string | null;
  precio_salida_por_millon: string | null;
  precio_por_bloque: string | null;
  tamano_bloque: string | null;
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
  /** Omit for a token price. Any other unit takes precioPorBloque and tamanoBloque instead of the two token prices. */
  unidad?: 'tokens' | 'caracteres' | 'segundos' | 'imagenes';
  /** USD per block, as a decimal string (non-token units only). */
  precioPorBloque?: string;
  tamanoBloque?: number;
  /** Omit to use the column default (now()). */
  vigenteDesde?: Date;
  nota?: string | null;
  creadoPor?: string;
}

/** Inserts a price with plain SQL (no permission check, no audit). Unique provider/model by default. */
export async function createPrecioModelo(db: Db, overrides: PrecioModeloOverrides = {}): Promise<PrecioModeloRow> {
  const suffix = uniqueSuffix();
  const unidad = overrides.unidad ?? 'tokens';
  const isTokens = unidad === 'tokens';
  const creadoPor = overrides.creadoPor ?? (await createUsuario(db)).id;
  const { rows } = await db.query<PrecioModeloRow>(
    `INSERT INTO precios_modelos
       (proveedor, modelo, unidad, precio_entrada_por_millon, precio_salida_por_millon, precio_por_bloque, tamano_bloque, vigente_desde, nota, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), $9, $10)
     RETURNING id, proveedor, modelo, unidad, precio_entrada_por_millon::text AS precio_entrada_por_millon,
       precio_salida_por_millon::text AS precio_salida_por_millon, precio_por_bloque::text AS precio_por_bloque,
       tamano_bloque::text AS tamano_bloque, vigente_desde, nota, creado_por, creado_en`,
    [
      overrides.proveedor ?? `fake_provider_${suffix}`,
      overrides.modelo ?? `fake-model-${suffix}`,
      unidad,
      isTokens ? (overrides.precioEntrada ?? '1.000000') : null,
      isTokens ? (overrides.precioSalida ?? '2.000000') : null,
      isTokens ? null : (overrides.precioPorBloque ?? '0.080000'),
      isTokens ? null : (overrides.tamanoBloque ?? 1000),
      overrides.vigenteDesde ?? null,
      overrides.nota ?? null,
      creadoPor,
    ],
  );
  return rows[0]!;
}
