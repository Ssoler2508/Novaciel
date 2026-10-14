import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../../../src/db/types.js';
import { createAutorizacionImagen } from './autorizacionesImagen.js';
import { createCliente } from './clientes.js';
import { uniqueSuffix } from './unique.js';

export interface MediaRow {
  id: string;
  cliente_id: string;
  tipo: 'foto' | 'video';
  clave_almacenamiento: string;
  nombre_original: string;
  mime: string;
  tamano_bytes: string;
  sha256: Buffer;
  ancho: number;
  alto: number;
  duracion_ms: number | null;
  etiquetas: string[];
  origen_derechos: string;
  nota_licencia: string | null;
  derechos_hasta: Date | null;
  aparecen_personas: boolean;
  subido_por: string | null;
  creado_en: Date;
  eliminado_en: Date | null;
}

export interface MediaOverrides {
  clienteId?: string;
  tipo?: 'foto' | 'video';
  claveAlmacenamiento?: string;
  nombreOriginal?: string;
  mime?: string;
  tamanoBytes?: number;
  sha256?: Buffer;
  ancho?: number;
  alto?: number;
  /** Defaults to 5000 for videos and NULL for photos. */
  duracionMs?: number | null;
  etiquetas?: string[];
  origenDerechos?: string;
  notaLicencia?: string | null;
  derechosHasta?: Date | null;
  aparecenPersonas?: boolean;
  subidoPor?: string | null;
  /** Creates the row already soft-deleted. */
  deleted?: boolean;
}

/** Inserts a media row with plain SQL (no storage, no audit). Fictional data; random unique hash and key. */
export async function createMedia(db: Db, overrides: MediaOverrides = {}): Promise<MediaRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const tipo = overrides.tipo ?? 'foto';
  const ext = tipo === 'foto' ? 'jpg' : 'mp4';
  const { rows } = await db.query<MediaRow>(
    `INSERT INTO media
       (cliente_id, tipo, clave_almacenamiento, nombre_original, mime, tamano_bytes, sha256, ancho, alto,
        duracion_ms, etiquetas, origen_derechos, nota_licencia, derechos_hasta, aparecen_personas, subido_por, eliminado_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CASE WHEN $17::boolean THEN now() END)
     RETURNING *`,
    [
      clienteId,
      tipo,
      overrides.claveAlmacenamiento ?? `${clienteId}/media/${randomUUID()}.${ext}`,
      overrides.nombreOriginal ?? `original-${uniqueSuffix()}.${ext}`,
      overrides.mime ?? (tipo === 'foto' ? 'image/jpeg' : 'video/mp4'),
      overrides.tamanoBytes ?? 1024,
      overrides.sha256 ?? randomBytes(32),
      overrides.ancho ?? 640,
      overrides.alto ?? 480,
      overrides.duracionMs !== undefined ? overrides.duracionMs : tipo === 'video' ? 5000 : null,
      overrides.etiquetas ?? [],
      overrides.origenDerechos ?? 'propio',
      overrides.notaLicencia ?? null,
      overrides.derechosHasta ?? null,
      overrides.aparecenPersonas ?? false,
      overrides.subidoPor ?? null,
      overrides.deleted ?? false,
    ],
  );
  return rows[0]!;
}

export interface MediaAutorizacionRow {
  media_id: string;
  autorizacion_id: string;
  cliente_id: string;
  creado_en: Date;
}

/** Links a media item to an authorization (plain SQL). Defaults to a new valid authorization of the media's client. */
export async function createMediaAutorizacion(
  db: Db,
  overrides: { mediaId: string; clienteId: string; autorizacionId?: string },
): Promise<MediaAutorizacionRow> {
  const autorizacionId =
    overrides.autorizacionId ?? (await createAutorizacionImagen(db, { clienteId: overrides.clienteId })).id;
  const { rows } = await db.query<MediaAutorizacionRow>(
    `INSERT INTO media_autorizaciones (media_id, autorizacion_id, cliente_id) VALUES ($1, $2, $3) RETURNING *`,
    [overrides.mediaId, autorizacionId, overrides.clienteId],
  );
  return rows[0]!;
}
