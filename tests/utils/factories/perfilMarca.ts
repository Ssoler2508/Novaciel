import type { Db } from '../../../src/db/types.js';
import { createCliente } from './clientes.js';
import { createUsuario } from './usuarios.js';

export const PERFIL_BLOCKS = [
  'identidad',
  'restricciones_sector',
  'audiencia',
  'voz',
  'pilares',
  'kit_visual',
  'objetivo',
  'operacion',
  'plan',
] as const;

export type PerfilBlock = (typeof PERFIL_BLOCKS)[number];

export interface PerfilMarcaRow extends Record<PerfilBlock, unknown> {
  id: string;
  cliente_id: string;
  version: number;
  es_actual: boolean;
  idioma_contenido: 'es' | 'en' | 'ambos' | null;
  creado_por: string;
  creado_en: Date;
}

export interface PerfilMarcaOverrides extends Partial<Record<PerfilBlock, unknown>> {
  clienteId?: string;
  creadoPor?: string;
  version?: number;
  esActual?: boolean;
  idiomaContenido?: string | null;
}

/** Inserts a perfil_marca version. Empty blocks by default; creates a client and a user when not given. */
export async function createPerfilMarca(db: Db, overrides: PerfilMarcaOverrides = {}): Promise<PerfilMarcaRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const creadoPor = overrides.creadoPor ?? (await createUsuario(db)).id;
  const version =
    overrides.version ??
    Number(
      (await db.query(`SELECT coalesce(max(version), 0) + 1 AS n FROM perfil_marca WHERE cliente_id = $1`, [clienteId]))
        .rows[0].n,
    );
  const blocks = PERFIL_BLOCKS.map((b) => JSON.stringify(b in overrides ? overrides[b] : {}));
  const { rows } = await db.query<PerfilMarcaRow>(
    `INSERT INTO perfil_marca
       (cliente_id, version, es_actual, ${PERFIL_BLOCKS.join(', ')}, idioma_contenido, creado_por)
     VALUES ($1, $2, $3, ${PERFIL_BLOCKS.map((_, i) => `$${i + 4}::jsonb`).join(', ')}, $${PERFIL_BLOCKS.length + 4}, $${PERFIL_BLOCKS.length + 5})
     RETURNING *`,
    [clienteId, version, overrides.esActual ?? true, ...blocks, overrides.idiomaContenido ?? null, creadoPor],
  );
  return rows[0]!;
}
