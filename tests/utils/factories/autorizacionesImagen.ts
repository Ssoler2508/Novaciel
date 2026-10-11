import type { Db } from '../../../src/db/types.js';
import { createCliente } from './clientes.js';
import { uniqueSuffix } from './unique.js';

export interface AutorizacionImagenRow {
  id: string;
  cliente_id: string;
  persona_nombre: string;
  alcance: string;
  vigente_desde: Date;
  vigente_hasta: Date;
  revocada_en: Date | null;
  documento_clave: string;
  es_menor: boolean;
  creado_en: Date;
}

export interface AutorizacionImagenOverrides {
  clienteId?: string;
  personaNombre?: string;
  alcance?: string;
  vigenteDesde?: Date;
  vigenteHasta?: Date;
  revocadaEn?: Date | null;
  documentoClave?: string;
  esMenor?: boolean;
  /** Creates the authorization already expired (valid from 10 days ago until yesterday). */
  expired?: boolean;
  /** Creates the authorization withdrawn one hour ago (valid since yesterday). */
  revoked?: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export async function createAutorizacionImagen(
  db: Db,
  overrides: AutorizacionImagenOverrides = {},
): Promise<AutorizacionImagenRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const suffix = uniqueSuffix();
  const now = Date.now();
  const desde =
    overrides.vigenteDesde ?? new Date(now - (overrides.expired ? 10 * DAY_MS : overrides.revoked ? DAY_MS : HOUR_MS));
  const hasta = overrides.vigenteHasta ?? new Date(now + (overrides.expired ? -DAY_MS : 365 * DAY_MS));
  const revocada =
    overrides.revocadaEn !== undefined ? overrides.revocadaEn : overrides.revoked ? new Date(now - HOUR_MS) : null;
  const { rows } = await db.query<AutorizacionImagenRow>(
    `INSERT INTO autorizaciones_imagen
       (cliente_id, persona_nombre, alcance, vigente_desde, vigente_hasta, revocada_en, documento_clave, es_menor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      clienteId,
      overrides.personaNombre ?? `Persona Ficticia ${suffix}`,
      overrides.alcance ?? 'Redes sociales del negocio',
      desde,
      hasta,
      revocada,
      overrides.documentoClave ?? `autorizaciones/ficticia-${suffix}.pdf`,
      overrides.esMenor ?? false,
    ],
  );
  return rows[0]!;
}
