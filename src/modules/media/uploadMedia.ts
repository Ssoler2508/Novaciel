import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import type { MediaProbe } from '../../lib/media/probe/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { validateMedia } from '../../lib/media/validateMedia.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';
import { DuplicateMediaError, FileTooLargeError, InvalidMediaInputError } from './errors.js';
import { assertClientAutorizaciones, getMedia, normalizeTags, parseRights, rightsSchema, type MediaRow } from './mediaRepository.js';

// Upload of a REAL photo or video of the client (rule 6: nothing here generates media).
// Never trust the file name or the declared type: the type comes from the content (B). The storage
// key is <cliente_id>/media/<uuid>.<ext>; the original name is only data. Logs carry metadata only.

export interface UploadMediaDeps {
  db: Db;
  storage: Pick<Storage, 'putFile' | 'delete'>;
  probe: MediaProbe;
  /** Largest accepted file, from config.media.maxBytes. */
  maxBytes: number;
  logger?: Logger;
}

const paramsSchema = z.object({
  filePath: z.string().min(1),
  originalName: z.string(),
  tags: z.array(z.string()).default([]),
  rights: rightsSchema,
  aparecenPersonas: z.boolean(),
  autorizacionIds: z.array(z.uuid()).optional(),
});
export type UploadMediaParams = z.input<typeof paramsSchema>;

const MAX_NAME_LENGTH = 255;

/** Last path segment only, control characters removed: the name is stored as data, never used as a path. */
function cleanOriginalName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  if (cleaned === '') throw new InvalidMediaInputError('The original file name is required');
  return cleaned;
}

/** Streams the file once: SHA-256 and byte count, aborting if it grows past the limit. */
async function hashFile(filePath: string, maxBytes: number): Promise<{ sha256: Buffer; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new FileTooLargeError(maxBytes);
    hash.update(chunk);
  }
  return { sha256: hash.digest(), size };
}

async function findLiveDuplicate(db: Db, clienteId: ClienteId, sha256: Buffer): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM media WHERE cliente_id = $1 AND sha256 = $2 AND eliminado_en IS NULL',
    [clienteId, sha256],
  );
  return rows[0]?.id ?? null;
}

export async function uploadMedia(
  deps: UploadMediaDeps,
  clienteId: ClienteId,
  rawParams: UploadMediaParams,
  actor: AuditActor,
): Promise<MediaRow> {
  const log = deps.logger ?? defaultLogger;
  const parsed = paramsSchema.safeParse(rawParams);
  if (!parsed.success) throw new InvalidMediaInputError('Invalid upload parameters');
  const params = parsed.data;
  const nombreOriginal = cleanOriginalName(params.originalName);
  const etiquetas = normalizeTags(params.tags);
  const rights = parseRights(params.rights);
  const autorizacionIds = [...new Set(params.autorizacionIds ?? [])];
  if (autorizacionIds.length > 0 && !params.aparecenPersonas) {
    throw new InvalidMediaInputError('Person links need aparecenPersonas = true');
  }

  // 1. Size, before any hashing or probing.
  const { size: statSize } = await stat(params.filePath);
  if (statSize > deps.maxBytes) throw new FileTooLargeError(deps.maxBytes);

  // 2. SHA-256 by streaming; 3. content validation (magic bytes + probe).
  const { sha256, size } = await hashFile(params.filePath, deps.maxBytes);
  const detected = await validateMedia({ filePath: params.filePath, probe: deps.probe });

  // 4. Duplicate and authorization checks, before anything is stored.
  const duplicateId = await findLiveDuplicate(deps.db, clienteId, sha256);
  if (duplicateId) throw new DuplicateMediaError(duplicateId);
  await assertClientAutorizaciones(deps.db, clienteId, autorizacionIds);

  // 5. Key from the client id and a random uuid; the extension comes from the detected type.
  const key = `${clienteId}/media/${randomUUID()}.${detected.extension}`;

  // 6. Store the file (streamed from disk).
  await deps.storage.putFile(key, params.filePath, detected.mime);

  // 7. Row, person links and audit in one transaction.
  try {
    const mediaId = await runInTransaction(deps.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO media
           (cliente_id, tipo, clave_almacenamiento, nombre_original, mime, tamano_bytes, sha256, ancho, alto, duracion_ms,
            etiquetas, origen_derechos, nota_licencia, derechos_hasta, aparecen_personas, subido_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          clienteId,
          detected.kind,
          key,
          nombreOriginal,
          detected.mime,
          size,
          sha256,
          detected.width,
          detected.height,
          detected.durationMs,
          etiquetas,
          rights.origen,
          rights.notaLicencia ?? null,
          rights.derechosHasta ?? null,
          params.aparecenPersonas,
          actor.tipo === 'usuario' ? actor.usuarioId : null,
        ],
      );
      const id = rows[0]!.id;
      if (autorizacionIds.length > 0) {
        await tx.query(
          'INSERT INTO media_autorizaciones (media_id, autorizacion_id, cliente_id) SELECT $1, unnest($3::uuid[]), $2',
          [id, clienteId, autorizacionIds],
        );
      }
      await recordAudit(tx, {
        actor,
        accion: 'crear',
        tabla: 'media',
        filaId: id,
        clienteId,
        // The original file name is deliberately not copied here: it can contain personal data.
        despues: {
          tipo: detected.kind,
          mime: detected.mime,
          tamano_bytes: size,
          sha256: sha256.toString('hex'),
          ancho: detected.width,
          alto: detected.height,
          duracion_ms: detected.durationMs,
          etiquetas,
          origen_derechos: rights.origen,
          derechos_hasta: rights.derechosHasta ?? null,
          aparecen_personas: params.aparecenPersonas,
          autorizacion_ids: autorizacionIds,
        },
      });
      return id;
    });
    log.info({ clienteId, mediaId, tipo: detected.kind, tamanoBytes: size, outcome: 'ok' }, 'media uploaded');
    return (await getMedia(deps.db, clienteId, mediaId))!;
  } catch (error) {
    await removeStoredFile(deps, clienteId, key, log);
    // Another upload of the same file won the race between the check and the insert.
    if (isDuplicateKeyError(error)) {
      const winner = await findLiveDuplicate(deps.db, clienteId, sha256);
      if (winner) throw new DuplicateMediaError(winner);
    }
    log.error({ clienteId, tipo: detected.kind, outcome: 'db_error', errorName: errorName(error) }, 'media upload failed after storing the file');
    throw error;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function isDuplicateKeyError(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === 'media_cliente_sha256_key';
}

/** Best effort: a failure here is logged with metadata only and never hides the original error. */
async function removeStoredFile(deps: UploadMediaDeps, clienteId: ClienteId, key: string, log: Logger): Promise<void> {
  try {
    await deps.storage.delete(key);
  } catch (error) {
    log.warn({ clienteId, outcome: 'orphan_file', errorName: errorName(error) }, 'could not remove the stored file after a failed upload');
  }
}
