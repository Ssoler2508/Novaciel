import fastifyMultipart from '@fastify/multipart';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/types.js';
import type { MediaProbe } from '../../lib/media/probe/types.js';
import { MediaProbeError } from '../../lib/media/probe/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { UnsupportedMediaError } from '../../lib/media/validateMedia.js';
import type { App } from '../auth/appType.js';
import { requirePermission } from '../auth/authorize.js';
import { can } from '../auth/permissions.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import {
  AutorizacionNotFoundError,
  DuplicateMediaError,
  FileTooLargeError,
  InvalidMediaInputError,
  MediaNotFoundError,
} from './errors.js';
import { getMedia, getMediaSignedUrl, listMedia, normalizeTags, softDeleteMedia, ORIGENES_DERECHOS } from './mediaRepository.js';
import { toMediaView } from './mediaView.js';
import { uploadMedia } from './uploadMedia.js';

// HTTP routes of the media library. The multipart parser streams the file to a private temp
// directory (never into memory) with the size limit enforced while streaming; the temp directory is
// always removed, before the response is sent. Error bodies never echo the file name, file
// content, paths or SQL.
//
// Note for clients: the CSRF guard of Step 2b requires "Content-Type: application/json" on every
// state-changing request except where a route opts in to more types, so DELETE must send it too.

export interface MediaRoutesOptions {
  db: Db;
  storage: Pick<Storage, 'putFile' | 'delete' | 'getSignedUrl'>;
  probe: MediaProbe;
  /** MEDIA_MAX_BYTES. */
  maxBytes: number;
  /** Where the private temp directories are created. Defaults to the OS temp folder. */
  tempDir?: string;
}

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const DEFAULT_URL_TTL_SECONDS = 300;
const MAX_URL_TTL_SECONDS = 3600;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_FIELD = 'file';
const TEXT_FIELDS = ['tags', 'origen_derechos', 'nota_licencia', 'derechos_hasta', 'aparecen_personas', 'autorizacion_ids'] as const;

const booleanText = z.enum(['true', 'false']).transform((v) => v === 'true');
const csv = (value: string) => value.split(',').map((s) => s.trim());

const uploadFields = z
  .object({
    aparecen_personas: booleanText,
    origen_derechos: z.enum(ORIGENES_DERECHOS).default('propio'),
    nota_licencia: z.string().trim().min(1).max(500).optional(),
    derechos_hasta: z.coerce.date().optional(),
    tags: z.string().max(2000).optional(),
    autorizacion_ids: z.string().max(2000).optional(),
  })
  .strict();

const listQuery = z
  .object({
    tipo: z.enum(['foto', 'video']).optional(),
    tags: z.string().max(2000).optional(),
    usable: booleanText.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const urlQuery = z.object({ ttl: z.coerce.number().int().min(1).max(MAX_URL_TTL_SECONDS).default(DEFAULT_URL_TTL_SECONDS) }).strict();

type Params = { clienteId: string };
type MediaParams = Params & { mediaId: string };

/** A response decided but not yet sent: the upload handler sends it only after the temp files are gone. */
interface Out {
  status: number;
  body: unknown;
  /** Close the connection after replying (used when we refuse to read the rest of a body). */
  close?: boolean;
}

function send(reply: FastifyReply, out: Out) {
  if (out.close) reply.header('connection', 'close');
  return reply.code(out.status).send(out.body);
}

function fieldNames(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? 'request')))];
}

const bad = (fields?: string[]): Out => ({ status: 400, body: { error: 'invalid_request', ...(fields ? { fields } : {}) } });
const notFound = (): Out => ({ status: 404, body: { error: 'not_found' } });

/** Too large: also close the connection, so the client stops sending a body we will not use. */
const tooLarge = (maxBytes: number): Out => ({ status: 413, body: { error: 'file_too_large', max_bytes: maxBytes }, close: true });

/** Maps the typed errors of the media service to responses. Returns null for an unknown error. */
function mediaErrorOut(error: unknown, maxBytes: number): Out | null {
  if (error instanceof FileTooLargeError) return tooLarge(maxBytes);
  if (error instanceof UnsupportedMediaError) return { status: 415, body: { error: 'unsupported_media_type' } };
  if (error instanceof DuplicateMediaError) return { status: 409, body: { error: 'duplicate', existing_id: error.existingId } };
  if (error instanceof InvalidMediaInputError) return bad();
  if (error instanceof AutorizacionNotFoundError) return { status: 422, body: { error: 'unknown_authorization' } };
  if (error instanceof MediaNotFoundError) return notFound();
  if (error instanceof MediaProbeError) {
    // ffprobe missing or too slow is our side (503); a file it cannot read is the client's (422).
    return error.code === 'not_found' || error.code === 'timeout'
      ? { status: 503, body: { error: 'probe_unavailable' } }
      : { status: 422, body: { error: 'unreadable_media' } };
  }
  return null;
}

export async function registerMediaRoutes(app: App, options: MediaRoutesOptions): Promise<void> {
  const { db, storage, probe, maxBytes } = options;

  await app.register(async (scope) => {
    // Explicit limits: the parser does not apply Fastify's bodyLimit to multipart bodies.
    await scope.register(fastifyMultipart, {
      limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 8 * 1024, fieldNameSize: 100, parts: 12 },
    });

    scope.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    // Only the error name is logged: messages could carry request content.
    scope.setErrorHandler((error, req, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return reply.code(status).send({ error: status === 413 ? 'file_too_large' : 'invalid_request' });
      }
      req.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'media route failed');
      return reply.code(500).send({ error: 'internal_error' });
    });

    /** Streams the file into the temp directory, validates the form fields and stores the media. */
    async function handleUpload(req: FastifyRequest<{ Params: Params }>, clienteId: ClienteId, tempRoot: string): Promise<Out> {
      const filePath = path.join(tempRoot, 'upload.bin');
      const fields = new Map<string, string>();
      let originalName: string | null = null;

      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (originalName !== null || part.fieldname !== FILE_FIELD) {
              part.file.resume();
              return bad(['file']);
            }
            await pipeline(part.file, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
            if (part.file.truncated) return tooLarge(maxBytes);
            originalName = part.filename;
          } else {
            if (!(TEXT_FIELDS as readonly string[]).includes(part.fieldname) || fields.has(part.fieldname) || part.valueTruncated) {
              return bad([part.fieldname.slice(0, 40)]);
            }
            fields.set(part.fieldname, String(part.value));
          }
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'FST_REQ_FILE_TOO_LARGE') return tooLarge(maxBytes);
        if (typeof code === 'string' && code.startsWith('FST_')) return bad();
        throw error;
      }

      if (originalName === null) return bad(['file']);
      const parsed = uploadFields.safeParse(Object.fromEntries(fields));
      if (!parsed.success) return bad(fieldNames(parsed.error));
      const f = parsed.data;

      let tags: string[];
      try {
        tags = f.tags === undefined || f.tags.trim() === '' ? [] : normalizeTags(csv(f.tags));
      } catch {
        return bad(['tags']);
      }
      const autorizacionIds = f.autorizacion_ids === undefined || f.autorizacion_ids.trim() === '' ? [] : csv(f.autorizacion_ids);
      if (autorizacionIds.some((id) => !UUID_RE.test(id))) return bad(['autorizacion_ids']);

      try {
        const media = await uploadMedia(
          { db, storage, probe, maxBytes },
          clienteId,
          {
            filePath,
            originalName,
            tags,
            rights: { origen: f.origen_derechos, notaLicencia: f.nota_licencia, derechosHasta: f.derechos_hasta ?? null },
            aparecenPersonas: f.aparecen_personas,
            autorizacionIds,
          },
          { tipo: 'usuario', usuarioId: req.auth!.user.id },
        );
        return { status: 201, body: toMediaView(media) };
      } catch (error) {
        const known = mediaErrorOut(error, maxBytes);
        if (known) return known;
        throw error;
      }
    }

    // ---- Upload ----
    scope.post<{ Params: Params }>(
      '/clientes/:clienteId/media',
      {
        config: { csrf: { allowedContentTypes: ['multipart/form-data'] } },
        preHandler: requirePermission(db, 'upload_material', (req) => (req.params as Params).clienteId),
      },
      async (req, reply) => {
        const clienteId = asClienteId(req.params.clienteId);
        // A JSON body passes the CSRF guard (JSON is always allowed) but is not an upload.
        if (!req.isMultipart()) return send(reply, { status: 415, body: { error: 'unsupported_media_type' } });
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes + MULTIPART_OVERHEAD_BYTES) return send(reply, tooLarge(maxBytes));

        const tempRoot = await mkdtemp(path.join(options.tempDir ?? os.tmpdir(), 'novaciel-upload-'));
        let out: Out;
        try {
          out = await handleUpload(req, clienteId, tempRoot);
        } finally {
          // Removed BEFORE the response is sent, so a client that has its answer can rely on it.
          await rm(tempRoot, { recursive: true, force: true });
        }
        return send(reply, out);
      },
    );

    // ---- List ----
    scope.get<{ Params: Params }>(
      '/clientes/:clienteId/media',
      { preHandler: requirePermission(db, 'read_client_data', (req) => (req.params as Params).clienteId) },
      async (req, reply) => {
        const query = listQuery.safeParse(req.query);
        if (!query.success) return send(reply, bad(fieldNames(query.error)));
        const q = query.data;
        let tags: string[] | undefined;
        try {
          tags = q.tags === undefined ? undefined : normalizeTags(csv(q.tags));
        } catch {
          return send(reply, bad(['tags']));
        }
        const rows = await listMedia(db, asClienteId(req.params.clienteId), {
          ...(q.tipo ? { tipo: q.tipo } : {}),
          ...(tags ? { tags } : {}),
          ...(q.usable !== undefined ? { usable: q.usable } : {}),
          limit: q.limit,
          offset: q.offset,
        });
        return { items: rows.map(toMediaView), limit: q.limit, offset: q.offset };
      },
    );

    // ---- Signed URL ----
    scope.get<{ Params: MediaParams }>(
      '/clientes/:clienteId/media/:mediaId/url',
      { preHandler: requirePermission(db, 'read_client_data', (req) => (req.params as Params).clienteId) },
      async (req, reply) => {
        const query = urlQuery.safeParse(req.query);
        if (!query.success) return send(reply, bad(fieldNames(query.error)));
        if (!UUID_RE.test(req.params.mediaId)) return send(reply, notFound());
        try {
          const url = await getMediaSignedUrl({ db, storage }, asClienteId(req.params.clienteId), req.params.mediaId, query.data.ttl);
          return { url, expires_in: query.data.ttl };
        } catch (error) {
          const known = mediaErrorOut(error, maxBytes);
          if (known) return send(reply, known);
          throw error;
        }
      },
    );

    // ---- Soft delete ----
    scope.delete<{ Params: MediaParams }>(
      '/clientes/:clienteId/media/:mediaId',
      { preHandler: requirePermission(db, 'upload_material', (req) => (req.params as Params).clienteId) },
      async (req, reply) => {
        if (!UUID_RE.test(req.params.mediaId)) return send(reply, notFound());
        const clienteId = asClienteId(req.params.clienteId);
        const media = await getMedia(db, clienteId, req.params.mediaId);
        if (!media) return send(reply, notFound());
        // The uploader may remove their own upload; anyone who may edit the client's profile
        // (NovaCiel staff and the owner) may remove anything of the client.
        const isUploader = media.subido_por !== null && media.subido_por === req.auth!.user.id;
        if (!isUploader && !can(req.auth!.roles, 'edit_brand_profile', clienteId)) {
          return reply.code(403).send({ error: 'forbidden' });
        }
        const deleted = await softDeleteMedia(db, clienteId, media.id, { tipo: 'usuario', usuarioId: req.auth!.user.id });
        if (!deleted) return send(reply, notFound());
        return reply.code(204).send();
      },
    );
  });
}
