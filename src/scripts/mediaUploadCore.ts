import path from 'node:path';
import type { Db } from '../db/types.js';
import { MediaProbeError } from '../lib/media/probe/types.js';
import type { MediaProbe } from '../lib/media/probe/types.js';
import type { Storage } from '../lib/media/storage/types.js';
import { UnsupportedMediaError } from '../lib/media/validateMedia.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import {
  AutorizacionNotFoundError,
  DuplicateMediaError,
  FileTooLargeError,
  InvalidMediaInputError,
} from '../modules/media/errors.js';
import { uploadMedia } from '../modules/media/uploadMedia.js';
import type { MediaUploadArgs } from './mediaUploadArgs.js';

export interface MediaUploadDeps {
  db: Db;
  storage: Pick<Storage, 'putFile' | 'delete'>;
  probe: MediaProbe;
  maxBytes: number;
}

export interface MediaUploadResult {
  ok: boolean;
  /** Lines to print. Never the file path, its content, or an error object. */
  lines: string[];
}

/**
 * Uploads one file for a client through uploadMedia (actor: sistema, rights "propio"). Every failure
 * becomes one short, content-free line. The file name is stored as data only.
 */
export async function runMediaUpload(deps: MediaUploadDeps, args: MediaUploadArgs): Promise<MediaUploadResult> {
  if (!(await getClienteById(deps.db, args.clienteId))) return { ok: false, lines: ['That client does not exist'] };
  try {
    const media = await uploadMedia(
      { db: deps.db, storage: deps.storage, probe: deps.probe, maxBytes: deps.maxBytes },
      args.clienteId,
      {
        filePath: args.filePath,
        originalName: path.basename(args.filePath),
        tags: args.tags,
        rights: { origen: 'propio' },
        aparecenPersonas: args.aparecenPersonas,
        ...(args.autorizacionId ? { autorizacionIds: [args.autorizacionId] } : {}),
      },
      { tipo: 'sistema' },
    );
    return {
      ok: true,
      lines: [
        `Uploaded media ${media.id}`,
        `  tipo: ${media.tipo} (${media.mime})`,
        `  size: ${media.tamano_bytes} bytes, ${media.ancho}x${media.alto}${media.duracion_ms === null ? '' : `, ${media.duracion_ms} ms`}`,
        `  tags: ${media.etiquetas.join(', ') || '(none)'}`,
        `  aparecen_personas: ${media.aparecen_personas}, linked authorizations: ${media.autorizacion_ids.length}`,
      ],
    };
  } catch (error) {
    return { ok: false, lines: [failureLine(error)] };
  }
}

function failureLine(error: unknown): string {
  if (error instanceof DuplicateMediaError) return `This file is already in the library (id ${error.existingId})`;
  if (error instanceof UnsupportedMediaError) return 'The file is not an accepted photo or video type';
  if (error instanceof FileTooLargeError) return `The file is larger than the allowed ${error.maxBytes} bytes`;
  if (error instanceof AutorizacionNotFoundError) return 'That image authorization does not exist for this client';
  if (error instanceof InvalidMediaInputError) return `Invalid input: ${error.message}`;
  if (error instanceof MediaProbeError) {
    return error.code === 'not_found' ? 'ffprobe could not be started: install it or set FFPROBE_PATH' : `The file could not be read as media (${error.message})`;
  }
  return `Upload failed (${error instanceof Error ? error.name : 'unknown error'})`;
}
