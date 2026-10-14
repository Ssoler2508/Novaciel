import { z } from 'zod';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';
import { AutorizacionNotFoundError, InvalidMediaInputError, MediaNotFoundError } from './errors.js';
import { usableCondition } from './usable.js';

export const ORIGENES_DERECHOS = ['propio', 'cedido_por_cliente', 'licenciado', 'material_de_terceros_con_permiso'] as const;
export type OrigenDerechos = (typeof ORIGENES_DERECHOS)[number];

export interface MediaRow {
  id: string;
  cliente_id: ClienteId;
  tipo: 'foto' | 'video';
  clave_almacenamiento: string;
  /** Kept only as data; never used for storage. */
  nombre_original: string;
  mime: string;
  tamano_bytes: number;
  /** Lower-case hex. */
  sha256: string;
  ancho: number;
  alto: number;
  duracion_ms: number | null;
  etiquetas: string[];
  origen_derechos: OrigenDerechos;
  nota_licencia: string | null;
  derechos_hasta: Date | null;
  aparecen_personas: boolean;
  subido_por: string | null;
  creado_en: Date;
  eliminado_en: Date | null;
  /** Authorizations of the people who appear. */
  autorizacion_ids: string[];
}

// m.* columns, with the hash as hex, the size as a number and the person links as an array.
export const MEDIA_COLUMNS = `m.id, m.cliente_id, m.tipo, m.clave_almacenamiento, m.nombre_original, m.mime,
  m.tamano_bytes::float8 AS tamano_bytes, encode(m.sha256, 'hex') AS sha256, m.ancho, m.alto, m.duracion_ms,
  m.etiquetas, m.origen_derechos, m.nota_licencia, m.derechos_hasta, m.aparecen_personas, m.subido_por,
  m.creado_en, m.eliminado_en,
  ARRAY(SELECT l.autorizacion_id FROM media_autorizaciones l
        WHERE l.media_id = m.id AND l.cliente_id = m.cliente_id ORDER BY l.autorizacion_id) AS autorizacion_ids`;

const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 40;

/** Trim, lower-case and de-duplicate. Empty or over-long tags are rejected, not silently dropped. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag === '' || tag.length > MAX_TAG_LENGTH) {
      throw new InvalidMediaInputError(`Each tag must have 1 to ${MAX_TAG_LENGTH} characters`);
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new InvalidMediaInputError(`At most ${MAX_TAGS} tags are allowed`);
  return out;
}

export const rightsSchema = z
  .object({
    origen: z.enum(ORIGENES_DERECHOS),
    notaLicencia: z.string().trim().min(1).optional(),
    derechosHasta: z.date().nullable().optional(),
  })
  .refine((r) => r.origen !== 'licenciado' || r.notaLicencia !== undefined, {
    message: 'A licensed file needs its license note',
  });
export type MediaRights = z.input<typeof rightsSchema>;

export function parseRights(input: unknown): z.output<typeof rightsSchema> {
  const parsed = rightsSchema.safeParse(input);
  if (!parsed.success) throw new InvalidMediaInputError('Invalid usage rights');
  return parsed.data;
}

/** Every id must be an authorization of this client, else AutorizacionNotFoundError. */
export async function assertClientAutorizaciones(db: Db, clienteId: ClienteId, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM autorizaciones_imagen WHERE cliente_id = $1 AND id = ANY($2::uuid[])',
    [clienteId, unique],
  );
  if (Number(rows[0]!.n) !== unique.length) throw new AutorizacionNotFoundError();
}

export async function getMedia(
  db: Db,
  clienteId: ClienteId,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<MediaRow | null> {
  const { rows } = await db.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media m
     WHERE m.id = $1 AND m.cliente_id = $2 ${options.includeDeleted ? '' : 'AND m.eliminado_en IS NULL'}`,
    [id, clienteId],
  );
  return rows[0] ?? null;
}

export interface ListMediaFilters {
  tipo?: 'foto' | 'video';
  /** The media must have ALL of these tags. */
  tags?: string[];
  /** true: only usable media (see usableCondition). */
  usable?: boolean;
  includeDeleted?: boolean;
  /** Instant for the usable rule; defaults to the database clock. */
  at?: Date;
  /** Page size; omit to get every row (internal callers). */
  limit?: number;
  offset?: number;
}

export async function listMedia(db: Db, clienteId: ClienteId, filters: ListMediaFilters = {}): Promise<MediaRow[]> {
  const params: unknown[] = [clienteId];
  const where = ['m.cliente_id = $1'];
  if (!filters.includeDeleted) where.push('m.eliminado_en IS NULL');
  if (filters.tipo) {
    params.push(filters.tipo);
    where.push(`m.tipo = $${params.length}`);
  }
  if (filters.tags && filters.tags.length > 0) {
    params.push(normalizeTags(filters.tags));
    where.push(`m.etiquetas @> $${params.length}::text[]`);
  }
  if (filters.usable) {
    let at = 'now()';
    if (filters.at) {
      params.push(filters.at);
      at = `$${params.length}`;
    }
    where.push(usableCondition(at));
  }
  // Newest first; id breaks ties (rows created in one transaction share creado_en), so pages are stable.
  let paging = '';
  if (filters.limit !== undefined) {
    params.push(filters.limit);
    paging += ` LIMIT $${params.length}`;
  }
  if (filters.offset !== undefined) {
    params.push(filters.offset);
    paging += ` OFFSET $${params.length}`;
  }
  const { rows } = await db.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media m WHERE ${where.join(' AND ')} ORDER BY m.creado_en DESC, m.id DESC${paging}`,
    params,
  );
  return rows;
}

/** Media usable at `at` (database clock when omitted). Applies the rule in one SQL condition. */
export function getUsableMedia(db: Db, clienteId: ClienteId, at?: Date): Promise<MediaRow[]> {
  return listMedia(db, clienteId, { usable: true, ...(at ? { at } : {}) });
}

/** Locks and returns a non-deleted media row of the client, or null. */
async function lockLiveMedia(db: Db, clienteId: ClienteId, id: string): Promise<MediaRow | null> {
  const { rows } = await db.query<MediaRow>(
    `SELECT ${MEDIA_COLUMNS} FROM media m
     WHERE m.id = $1 AND m.cliente_id = $2 AND m.eliminado_en IS NULL FOR UPDATE OF m`,
    [id, clienteId],
  );
  return rows[0] ?? null;
}

/** Replaces the human tags. Null when the client has no such (non-deleted) media. */
export async function updateMediaTags(
  db: Db,
  clienteId: ClienteId,
  id: string,
  tags: readonly string[],
  actor: AuditActor,
): Promise<MediaRow | null> {
  const etiquetas = normalizeTags(tags);
  return runInTransaction(db, async (tx) => {
    const before = await lockLiveMedia(tx, clienteId, id);
    if (!before) return null;
    await tx.query('UPDATE media SET etiquetas = $3 WHERE id = $1 AND cliente_id = $2', [id, clienteId, etiquetas]);
    await recordAudit(tx, {
      actor,
      accion: 'actualizar_etiquetas',
      tabla: 'media',
      filaId: id,
      clienteId,
      antes: { etiquetas: before.etiquetas },
      despues: { etiquetas },
    });
    return (await getMedia(tx, clienteId, id))!;
  });
}

/** Replaces the usage rights (origin, license note, expiry). Null when not found or deleted. */
export async function updateMediaRights(
  db: Db,
  clienteId: ClienteId,
  id: string,
  rights: MediaRights,
  actor: AuditActor,
): Promise<MediaRow | null> {
  const parsed = parseRights(rights);
  return runInTransaction(db, async (tx) => {
    const before = await lockLiveMedia(tx, clienteId, id);
    if (!before) return null;
    await tx.query(
      'UPDATE media SET origen_derechos = $3, nota_licencia = $4, derechos_hasta = $5 WHERE id = $1 AND cliente_id = $2',
      [id, clienteId, parsed.origen, parsed.notaLicencia ?? null, parsed.derechosHasta ?? null],
    );
    const after = (await getMedia(tx, clienteId, id))!;
    await recordAudit(tx, {
      actor,
      accion: 'actualizar_derechos',
      tabla: 'media',
      filaId: id,
      clienteId,
      antes: { origen_derechos: before.origen_derechos, nota_licencia: before.nota_licencia, derechos_hasta: before.derechos_hasta },
      despues: { origen_derechos: after.origen_derechos, nota_licencia: after.nota_licencia, derechos_hasta: after.derechos_hasta },
    });
    return after;
  });
}

/**
 * Links people (image authorizations of this client) to a media item. Only for media that says
 * people appear. Already-linked ids are ignored; only real changes are audited.
 * Returns the ids actually linked, or null when the media is not found.
 */
export async function linkPersons(
  db: Db,
  clienteId: ClienteId,
  mediaId: string,
  autorizacionIds: readonly string[],
  actor: AuditActor,
): Promise<{ linked: string[] } | null> {
  const ids = [...new Set(autorizacionIds)];
  return runInTransaction(db, async (tx) => {
    const media = await lockLiveMedia(tx, clienteId, mediaId);
    if (!media) return null;
    if (!media.aparecen_personas) throw new InvalidMediaInputError('This media item says no people appear');
    await assertClientAutorizaciones(tx, clienteId, ids);
    const { rows } = await tx.query<{ autorizacion_id: string }>(
      `INSERT INTO media_autorizaciones (media_id, autorizacion_id, cliente_id)
       SELECT $1, unnest($3::uuid[]), $2
       ON CONFLICT DO NOTHING
       RETURNING autorizacion_id`,
      [mediaId, clienteId, ids],
    );
    const linked = rows.map((r) => r.autorizacion_id);
    if (linked.length > 0) {
      await recordAudit(tx, {
        actor,
        accion: 'vincular_personas',
        tabla: 'media',
        filaId: mediaId,
        clienteId,
        despues: { autorizacion_ids: linked },
      });
    }
    return { linked };
  });
}

/** Removes person links. Returns the ids actually unlinked, or null when the media is not found. */
export async function unlinkPersons(
  db: Db,
  clienteId: ClienteId,
  mediaId: string,
  autorizacionIds: readonly string[],
  actor: AuditActor,
): Promise<{ unlinked: string[] } | null> {
  const ids = [...new Set(autorizacionIds)];
  return runInTransaction(db, async (tx) => {
    const media = await lockLiveMedia(tx, clienteId, mediaId);
    if (!media) return null;
    const { rows } = await tx.query<{ autorizacion_id: string }>(
      `DELETE FROM media_autorizaciones
       WHERE media_id = $1 AND cliente_id = $2 AND autorizacion_id = ANY($3::uuid[])
       RETURNING autorizacion_id`,
      [mediaId, clienteId, ids],
    );
    const unlinked = rows.map((r) => r.autorizacion_id);
    if (unlinked.length > 0) {
      await recordAudit(tx, {
        actor,
        accion: 'desvincular_personas',
        tabla: 'media',
        filaId: mediaId,
        clienteId,
        antes: { autorizacion_ids: unlinked },
      });
    }
    return { unlinked };
  });
}

/**
 * Soft delete. The stored file is kept on purpose: later pieces may need it as evidence (a cleanup
 * after the retention period is future work). Null when not found or already deleted.
 */
export async function softDeleteMedia(db: Db, clienteId: ClienteId, id: string, actor: AuditActor): Promise<MediaRow | null> {
  return runInTransaction(db, async (tx) => {
    const before = await lockLiveMedia(tx, clienteId, id);
    if (!before) return null;
    await tx.query('UPDATE media SET eliminado_en = now() WHERE id = $1 AND cliente_id = $2', [id, clienteId]);
    const after = (await getMedia(tx, clienteId, id, { includeDeleted: true }))!;
    await recordAudit(tx, {
      actor,
      accion: 'eliminar',
      tabla: 'media',
      filaId: id,
      clienteId,
      antes: { eliminado_en: null },
      despues: { eliminado_en: after.eliminado_en!.toISOString() },
    });
    return after;
  });
}

const MAX_SIGNED_URL_TTL_SECONDS = 3600;

/** A short-lived signed URL, only for the client's own non-deleted media. */
export async function getMediaSignedUrl(
  deps: { db: Db; storage: Pick<Storage, 'getSignedUrl'> },
  clienteId: ClienteId,
  mediaId: string,
  ttlSeconds: number,
): Promise<string> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
    throw new InvalidMediaInputError(`ttlSeconds must be an integer from 1 to ${MAX_SIGNED_URL_TTL_SECONDS}`);
  }
  const media = await getMedia(deps.db, clienteId, mediaId);
  if (!media) throw new MediaNotFoundError();
  return deps.storage.getSignedUrl(media.clave_almacenamiento, ttlSeconds);
}
