import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import {
  assignRole,
  createAutorizacionImagen,
  createCliente,
  createMedia,
  createUsuario,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeMediaProbe } from '../../lib/media/probe/fakeMediaProbe.js';
import { MediaProbeError, type ProbeResult } from '../../lib/media/probe/types.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { LocalFileStorage } from '../../lib/media/storage/localFileStorage.js';
import { registerLocalFileRoute } from '../../lib/media/storage/localFileRoute.js';
import { registerAuth } from '../auth/authRoutes.js';
import { registerMediaRoutes } from './mediaRoutes.js';

// Same pattern as authRoutes.test.ts: one test-transaction client as Db, app.inject(), rollback.
// Multipart bodies are built by hand. No test touches the network or ffprobe.

const ORIGIN = 'http://localhost:3999';
const PASSWORD = 'correct horse battery';
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const NAME_SECRET = 'NOMBRE-PRIVADO-DE-LA-PERSONA';
const CONTENT_SECRET = 'CONTENIDO-SECRETO-DEL-ARCHIVO';
const NOVACIEL = ['administrador_novaciel', 'operador_novaciel'];

const photo = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  kind: 'foto', format: 'jpeg_pipe', mime: 'image/jpeg', width: 640, height: 480, durationMs: null, ...overrides,
});
const jpeg = (extra: Buffer = randomBytes(64)) => Buffer.concat([JPEG_MAGIC, extra]);

let roots: string[] = [];
let tempRoot: string;
beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'novaciel-routes-'));
  roots.push(tempRoot);
});
afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

interface Part {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  content?: Buffer;
}

function multipart(parts: Part[]): { payload: Buffer; contentType: string } {
  const boundary = `----novaciel${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.contentType) head += `Content-Type: ${part.contentType}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`), part.content ?? Buffer.from(part.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const filePart = (content: Buffer, filename = 'foto.jpg', name = 'file'): Part => ({
  name, filename, content, contentType: 'application/octet-stream',
});

async function build(db: Db, overrides: { maxBytes?: number; storage?: FakeStorage | LocalFileStorage } = {}) {
  const logs: string[] = [];
  const logger = createLogger('debug', { write: (line: string) => void logs.push(line) });
  const app = Fastify({ loggerInstance: logger });
  // Typed as FakeStorage for the helpers (keys/has); the local-file test passes a LocalFileStorage and never uses them.
  const storage = (overrides.storage ?? new FakeStorage()) as FakeStorage;
  const probe = new FakeMediaProbe();
  const tempDir = await mkdtemp(path.join(tempRoot, 'tmp-'));
  await registerAuth(app, { db, allowedOrigin: ORIGIN });
  await registerMediaRoutes(app, { db, storage, probe, maxBytes: overrides.maxBytes ?? 1_000_000, tempDir });
  if (storage instanceof LocalFileStorage) registerLocalFileRoute(app, storage);
  return { app, storage, probe, logs, tempDir };
}

type Ctx = Awaited<ReturnType<typeof build>>;

async function withMediaApp(fn: (ctx: Ctx & { db: Db }) => Promise<void>, overrides: Parameters<typeof build>[1] = {}) {
  await withTestTransaction(async (db) => {
    const ctx = await build(db, overrides);
    try {
      await fn({ ...ctx, db });
    } finally {
      await ctx.app.close();
    }
  });
}

/** A user with a role (for the client, unless it is a NovaCiel role), logged in; returns the cookie header. */
async function login(ctx: Ctx & { db: Db }, rol: string, clienteId: string | null) {
  const user = await createUsuario(ctx.db, { password: PASSWORD });
  await assignRole(ctx.db, { usuarioId: user.id, rolCodigo: rol, clienteId: NOVACIEL.includes(rol) ? null : clienteId });
  const res = await ctx.app.inject({
    method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: user.email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return { user, headers: { cookie: String(res.headers['set-cookie']).split(';')[0]! } };
}

type Session = Awaited<ReturnType<typeof login>>;

function upload(ctx: Ctx, session: Session | null, clienteId: string, parts: Part[], headers: Record<string, string> = {}) {
  const body = multipart(parts);
  return ctx.app.inject({
    method: 'POST',
    url: `/clientes/${clienteId}/media`,
    headers: { 'content-type': body.contentType, ...(session?.headers ?? {}), ...headers },
    payload: body.payload,
  });
}

const okFields: Part[] = [{ name: 'aparecen_personas', value: 'false' }];
const get = (ctx: Ctx, session: Session, url: string) => ctx.app.inject({ method: 'GET', url, headers: session.headers });
// The CSRF guard of Step 2b requires Content-Type: application/json on every state-changing request.
const del = (ctx: Ctx, session: Session, url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'DELETE', url, headers: { 'content-type': 'application/json', ...session.headers, ...headers } });

async function setup(ctx: Ctx & { db: Db }, rol = 'dueno_cliente') {
  const cliente = await createCliente(ctx.db);
  return { clienteId: cliente.id, owner: await login(ctx, rol, cliente.id) };
}

describe('POST /clientes/:clienteId/media', () => {
  it('stores the upload, returns the public metadata, audits it and leaves no temp files', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const content = jpeg();
      ctx.probe.enqueue(photo());
      const res = await upload(ctx, owner, clienteId, [
        filePart(content, 'C:\\fotos\\Mi Fachada.JPG'),
        { name: 'tags', value: ' Fachada, CAFE ,cafe' },
        { name: 'aparecen_personas', value: 'false' },
        { name: 'origen_derechos', value: 'cedido_por_cliente' },
      ]);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        tipo: 'foto', mime: 'image/jpeg', tamano_bytes: content.length, ancho: 640, alto: 480, duracion_ms: null,
        etiquetas: ['fachada', 'cafe'], origen_derechos: 'cedido_por_cliente', aparecen_personas: false,
        autorizacion_ids: [], nombre_original: 'Mi Fachada.JPG', subido_por: owner.user.id,
      });
      expect(body).not.toHaveProperty('clave_almacenamiento');
      expect(body).not.toHaveProperty('sha256');
      expect(res.headers['cache-control']).toBe('no-store');

      const row = (await ctx.db.query('SELECT clave_almacenamiento, encode(sha256, \'hex\') AS sha FROM media WHERE id = $1', [body.id])).rows[0];
      expect(row.clave_almacenamiento).toMatch(new RegExp(`^${clienteId}/media/[0-9a-f-]{36}\\.jpg$`));
      expect(row.sha).toBe(createHash('sha256').update(content).digest('hex'));
      expect((await ctx.storage.get(row.clave_almacenamiento)).equals(content)).toBe(true);
      const audit = await ctx.db.query(`SELECT actor_usuario_id FROM auditoria WHERE tabla = 'media' AND fila_id = $1`, [body.id]);
      expect(audit.rows).toEqual([{ actor_usuario_id: owner.user.id }]);
      expect(await readdir(ctx.tempDir)).toEqual([]);
    });
  });

  it('links the people who appear and accepts rights fields', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const a1 = await createAutorizacionImagen(ctx.db, { clienteId });
      ctx.probe.enqueue(photo());
      const res = await upload(ctx, owner, clienteId, [
        filePart(jpeg()),
        { name: 'aparecen_personas', value: 'true' },
        { name: 'autorizacion_ids', value: a1.id },
        { name: 'origen_derechos', value: 'licenciado' },
        { name: 'nota_licencia', value: 'Licencia ficticia 2026' },
        { name: 'derechos_hasta', value: '2030-01-01' },
      ]);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ aparecen_personas: true, autorizacion_ids: [a1.id], origen_derechos: 'licenciado', nota_licencia: 'Licencia ficticia 2026' });
    });
  });

  it('is allowed for a NovaCiel administrator and for colaborador_cliente (upload_material), not for a stranger', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId } = await setup(ctx);
      const admin = await login(ctx, 'administrador_novaciel', null);
      const collaborator = await login(ctx, 'colaborador_cliente', clienteId);
      const stranger = await login(ctx, 'dueno_cliente', (await createCliente(ctx.db)).id);
      ctx.probe.enqueue(photo(), photo());
      expect((await upload(ctx, admin, clienteId, [filePart(jpeg()), ...okFields])).statusCode).toBe(201);
      expect((await upload(ctx, collaborator, clienteId, [filePart(jpeg()), ...okFields])).statusCode).toBe(201);
      expect((await upload(ctx, stranger, clienteId, [filePart(jpeg()), ...okFields])).statusCode).toBe(403);
    });
  });

  it('answers 401 without a session and 403 for another client, storing nothing', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId } = await setup(ctx);
      const other = await setup(ctx);
      ctx.probe.enqueue(photo());
      expect((await upload(ctx, null, clienteId, [filePart(jpeg()), ...okFields])).statusCode).toBe(401);
      // The owner of another client uploading into this client.
      expect((await upload(ctx, other.owner, clienteId, [filePart(jpeg()), ...okFields])).statusCode).toBe(403);
      expect((await upload(ctx, other.owner, 'not-a-uuid', [filePart(jpeg()), ...okFields])).statusCode).toBe(403);
      expect(ctx.storage.keys()).toEqual([]);
      expect(ctx.probe.calls).toEqual([]);
      expect((await ctx.db.query('SELECT 1 FROM media WHERE cliente_id = $1', [clienteId])).rows).toEqual([]);
    });
  });

  it('too large: 413 when the declared size is over the limit, before reading, and no temp files remain', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      ctx.probe.enqueue(photo());
      const res = await upload(ctx, owner, clienteId, [filePart(jpeg(Buffer.alloc(80_000))), ...okFields]);
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: 'file_too_large', max_bytes: 1000 });
      expect(await readdir(ctx.tempDir)).toEqual([]);
      expect(ctx.storage.keys()).toEqual([]);
      expect(ctx.probe.calls).toEqual([]);
    }, { maxBytes: 1000 });
  });

  it('too large: 413 when the stream overflows the limit while parsing, and no temp files remain', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      ctx.probe.enqueue(photo());
      // 5,000 bytes: under the early (declared size) limit, over the 1,000 byte file limit.
      const res = await upload(ctx, owner, clienteId, [filePart(jpeg(Buffer.alloc(5000))), ...okFields]);
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe('file_too_large');
      expect(await readdir(ctx.tempDir)).toEqual([]);
      expect(ctx.storage.keys()).toEqual([]);
      expect((await ctx.db.query('SELECT 1 FROM media WHERE cliente_id = $1', [clienteId])).rows).toEqual([]);
    }, { maxBytes: 1000 });
  });

  it('a file exactly at the limit is accepted', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      ctx.probe.enqueue(photo());
      const res = await upload(ctx, owner, clienteId, [filePart(jpeg(Buffer.alloc(1000 - JPEG_MAGIC.length, 7))), ...okFields]);
      expect(res.statusCode).toBe(201);
    }, { maxBytes: 1000 });
  });

  it('rejects SVG, HTML and PDF named .jpg with 415 and never echoes the file name', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const hostile = [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        Buffer.from('<!doctype html><html></html>'),
        Buffer.from('%PDF-1.4 fake'),
        Buffer.from('MZ' + 'x'.repeat(80)),
      ];
      for (const content of hostile) {
        const res = await upload(ctx, owner, clienteId, [filePart(content, `${NAME_SECRET}.jpg`), ...okFields]);
        expect(res.statusCode).toBe(415);
        expect(res.json()).toEqual({ error: 'unsupported_media_type' });
        expect(res.body).not.toContain(NAME_SECRET);
      }
      expect(ctx.storage.keys()).toEqual([]);
      expect(ctx.probe.calls).toEqual([]);
      expect(await readdir(ctx.tempDir)).toEqual([]);
    });
  });

  it('a duplicate gives 409 with the existing id, and is allowed again after the delete route', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const content = jpeg();
      ctx.probe.enqueue(photo(), photo(), photo());
      const first = await upload(ctx, owner, clienteId, [filePart(content), ...okFields]);
      expect(first.statusCode).toBe(201);
      const again = await upload(ctx, owner, clienteId, [filePart(content, 'otro-nombre.jpg'), ...okFields]);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'duplicate', existing_id: first.json().id });
      expect((await del(ctx, owner, `/clientes/${clienteId}/media/${first.json().id}`)).statusCode).toBe(204);
      expect((await upload(ctx, owner, clienteId, [filePart(content), ...okFields])).statusCode).toBe(201);
    });
  });

  it('rejects a wrong Origin (403), text/plain and JSON bodies (415); no Origin header is fine', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      ctx.probe.enqueue(photo());
      const wrong = await upload(ctx, owner, clienteId, [filePart(jpeg()), ...okFields], { origin: 'http://evil.example.test' });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toEqual({ error: 'forbidden_origin' });
      const right = await upload(ctx, owner, clienteId, [filePart(jpeg()), ...okFields], { origin: ORIGIN });
      expect(right.statusCode).toBe(201);
      for (const type of ['text/plain', 'application/json', 'application/x-www-form-urlencoded']) {
        const res = await ctx.app.inject({
          method: 'POST', url: `/clientes/${clienteId}/media`, headers: { 'content-type': type, ...owner.headers }, payload: type === 'application/json' ? '{}' : 'hello',
        });
        expect(res.statusCode).toBe(415);
      }
      expect(ctx.storage.keys()).toHaveLength(1);
    });
  });

  it('validates the form fields: 400 with field names only, nothing stored, no temp files', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const secret = 'VALOR-SECRETO-DEL-CAMPO';
      const cases: [string, Part[], string][] = [
        ['missing aparecen_personas', [filePart(jpeg())], 'aparecen_personas'],
        ['bad boolean', [filePart(jpeg()), { name: 'aparecen_personas', value: secret }], 'aparecen_personas'],
        ['bad origin', [filePart(jpeg()), ...okFields, { name: 'origen_derechos', value: secret }], 'origen_derechos'],
        ['licenciado without a note', [filePart(jpeg()), ...okFields, { name: 'origen_derechos', value: 'licenciado' }], ''],
        ['bad date', [filePart(jpeg()), ...okFields, { name: 'derechos_hasta', value: secret }], 'derechos_hasta'],
        ['bad uuid', [filePart(jpeg()), { name: 'aparecen_personas', value: 'true' }, { name: 'autorizacion_ids', value: secret }], 'autorizacion_ids'],
        ['unknown field', [filePart(jpeg()), ...okFields, { name: 'extra', value: secret }], 'extra'],
        ['repeated field', [filePart(jpeg()), ...okFields, { name: 'aparecen_personas', value: 'false' }], 'aparecen_personas'],
        ['empty tag', [filePart(jpeg()), ...okFields, { name: 'tags', value: 'a,,b' }], 'tags'],
        ['no file', [...okFields], 'file'],
        ['two files', [filePart(jpeg()), filePart(jpeg()), ...okFields], ''],
        ['file under another field name', [filePart(jpeg(), 'a.jpg', 'foto'), ...okFields], 'file'],
      ];
      for (const [label, parts, field] of cases) {
        ctx.probe.enqueue(photo());
        const res = await upload(ctx, owner, clienteId, parts);
        expect(res.statusCode, label).toBe(400);
        expect(res.json().error, label).toBe('invalid_request');
        if (field) expect(res.json().fields, label).toContain(field);
        expect(res.body, label).not.toContain(secret);
      }
      expect(ctx.storage.keys()).toEqual([]);
      expect(await readdir(ctx.tempDir)).toEqual([]);
    });
  });

  it('answers 422 for an authorization of another client, and maps probe failures', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const foreign = await createAutorizacionImagen(ctx.db);
      ctx.probe.enqueue(photo());
      const unknown = await upload(ctx, owner, clienteId, [filePart(jpeg()), { name: 'aparecen_personas', value: 'true' }, { name: 'autorizacion_ids', value: foreign.id }]);
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json()).toEqual({ error: 'unknown_authorization' });

      for (const [code, status, error] of [['parse', 422, 'unreadable_media'], ['exit_nonzero', 422, 'unreadable_media'], ['timeout', 503, 'probe_unavailable'], ['not_found', 503, 'probe_unavailable']] as const) {
        ctx.probe.enqueue({ error: new MediaProbeError(code, code === 'exit_nonzero' ? 1 : undefined) });
        const res = await upload(ctx, owner, clienteId, [filePart(jpeg()), ...okFields]);
        expect(res.statusCode, code).toBe(status);
        expect(res.json(), code).toEqual({ error });
      }
      expect(ctx.storage.keys()).toEqual([]);
      expect(await readdir(ctx.tempDir)).toEqual([]);
    });
  });

  it('logs contain no file name, no file content and no temp path', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      ctx.probe.enqueue(photo(), photo());
      await upload(ctx, owner, clienteId, [filePart(jpeg(Buffer.from(CONTENT_SECRET)), `${NAME_SECRET}.jpg`), ...okFields]);
      await upload(ctx, owner, clienteId, [filePart(Buffer.from(`<svg>${CONTENT_SECRET}</svg>`), `${NAME_SECRET}.svg.jpg`), ...okFields]);
      await upload(ctx, owner, clienteId, [filePart(jpeg(Buffer.from(CONTENT_SECRET)), `${NAME_SECRET}.jpg`), ...okFields]); // duplicate
      const logs = ctx.logs.join('');
      for (const hidden of [NAME_SECRET, CONTENT_SECRET, tempRoot, ctx.tempDir]) expect(logs).not.toContain(hidden);
    });
  });
});

describe('GET /clientes/:clienteId/media', () => {
  it('follows the matrix: colaborador cannot list, aprobador and owner can', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const collaborator = await login(ctx, 'colaborador_cliente', clienteId);
      const approver = await login(ctx, 'aprobador_cliente', clienteId);
      await createMedia(ctx.db, { clienteId });
      expect((await get(ctx, collaborator, `/clientes/${clienteId}/media`)).statusCode).toBe(403);
      expect((await get(ctx, approver, `/clientes/${clienteId}/media`)).statusCode).toBe(200);
      const res = await get(ctx, owner, `/clientes/${clienteId}/media`);
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toHaveLength(1);
      expect(res.json().items[0]).not.toHaveProperty('clave_almacenamiento');
      expect((await ctx.app.inject({ method: 'GET', url: `/clientes/${clienteId}/media` })).statusCode).toBe(401);
    });
  });

  it("another client's id gives 403 and never shows its media", async () => {
    await withMediaApp(async (ctx) => {
      const a = await setup(ctx);
      const b = await setup(ctx);
      await createMedia(ctx.db, { clienteId: b.clienteId });
      expect((await get(ctx, a.owner, `/clientes/${b.clienteId}/media`)).statusCode).toBe(403);
      expect((await get(ctx, a.owner, `/clientes/${a.clienteId}/media`)).json().items).toEqual([]);
    });
  });

  it('filters by tipo, by all tags, by usable, and hides deleted media', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const both = await createMedia(ctx.db, { clienteId, etiquetas: ['cafe', 'fachada'] });
      const onlyCafe = await createMedia(ctx.db, { clienteId, etiquetas: ['cafe'] });
      const video = await createMedia(ctx.db, { clienteId, tipo: 'video', etiquetas: ['cafe', 'fachada'] });
      const people = await createMedia(ctx.db, { clienteId, aparecenPersonas: true, etiquetas: ['gente'] });
      await createMedia(ctx.db, { clienteId, etiquetas: ['cafe', 'fachada'], deleted: true });
      const ids = async (query: string) => (await get(ctx, owner, `/clientes/${clienteId}/media${query}`)).json().items.map((m: { id: string }) => m.id).sort();

      expect(await ids('?tags=CAFE')).toEqual([both.id, onlyCafe.id, video.id].sort());
      expect(await ids('?tags=cafe,%20fachada')).toEqual([both.id, video.id].sort());
      expect(await ids('?tipo=video')).toEqual([video.id]);
      expect(await ids('?tipo=foto&tags=fachada')).toEqual([both.id]);
      expect(await ids('?usable=true')).toEqual([both.id, onlyCafe.id, video.id].sort()); // people without authorizations: not usable
      expect(await ids('?usable=false')).toContain(people.id);
      expect((await ids('')).length).toBe(4);
    });
  });

  it('is bounded: default 100, limit above 200 is rejected, offset works, ordering is stable', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      // All created in one transaction: identical creado_en, so only the id tie-break orders them.
      const created = [];
      for (let i = 0; i < 5; i++) created.push((await createMedia(ctx.db, { clienteId })).id);
      const expected = [...created].sort().reverse();
      const page = async (limit: number, offset: number) => (await get(ctx, owner, `/clientes/${clienteId}/media?limit=${limit}&offset=${offset}`)).json();

      const all = (await get(ctx, owner, `/clientes/${clienteId}/media`)).json();
      expect(all).toMatchObject({ limit: 100, offset: 0 });
      expect(all.items.map((m: { id: string }) => m.id)).toEqual(expected);

      const pages = [await page(2, 0), await page(2, 2), await page(2, 4), await page(2, 6)];
      expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1, 0]);
      expect(pages.flatMap((p) => p.items.map((m: { id: string }) => m.id))).toEqual(expected);
      expect((await page(2, 0)).items.map((m: { id: string }) => m.id)).toEqual((await page(2, 0)).items.map((m: { id: string }) => m.id));

      expect((await get(ctx, owner, `/clientes/${clienteId}/media?limit=200`)).statusCode).toBe(200);
      for (const bad of ['limit=201', 'limit=0', 'limit=-1', 'limit=abc', 'offset=-1', 'offset=1.5', 'sort=asc', 'include_deleted=true', 'tipo=audio', 'usable=maybe']) {
        const res = await get(ctx, owner, `/clientes/${clienteId}/media?${bad}`);
        expect(res.statusCode, bad).toBe(400);
        expect(res.json().error).toBe('invalid_request');
      }
    });
  });

  it('newer media come first', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const old = await createMedia(ctx.db, { clienteId });
      await ctx.db.query(`UPDATE media SET creado_en = now() - interval '2 days' WHERE id = $1`, [old.id]);
      const recent = await createMedia(ctx.db, { clienteId });
      const ids = (await get(ctx, owner, `/clientes/${clienteId}/media`)).json().items.map((m: { id: string }) => m.id);
      expect(ids).toEqual([recent.id, old.id]);
    });
  });
});

describe('GET /clientes/:clienteId/media/:mediaId/url', () => {
  async function uploaded(ctx: Ctx & { db: Db }) {
    const { clienteId, owner } = await setup(ctx);
    ctx.probe.enqueue(photo());
    const res = await upload(ctx, owner, clienteId, [filePart(jpeg()), ...okFields]);
    return { clienteId, owner, mediaId: res.json().id as string };
  }

  it('returns a signed URL with the default and an explicit ttl, and rejects a bad ttl', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner, mediaId } = await uploaded(ctx);
      const base = `/clientes/${clienteId}/media/${mediaId}/url`;
      const def = await get(ctx, owner, base);
      expect(def.statusCode).toBe(200);
      expect(def.json()).toMatchObject({ expires_in: 300 });
      expect(def.json().url).toContain('memory://');
      expect((await get(ctx, owner, `${base}?ttl=60`)).json().expires_in).toBe(60);
      for (const ttl of ['0', '3601', '-5', 'abc', '1.5']) expect((await get(ctx, owner, `${base}?ttl=${ttl}`)).statusCode, ttl).toBe(400);
    });
  });

  it('is 404 for a deleted, unknown or malformed id, and 403 for the collaborator', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner, mediaId } = await uploaded(ctx);
      const collaborator = await login(ctx, 'colaborador_cliente', clienteId);
      expect((await get(ctx, collaborator, `/clientes/${clienteId}/media/${mediaId}/url`)).statusCode).toBe(403);
      expect((await get(ctx, owner, `/clientes/${clienteId}/media/${randomUUID()}/url`)).statusCode).toBe(404);
      expect((await get(ctx, owner, `/clientes/${clienteId}/media/not-a-uuid/url`)).statusCode).toBe(404);
      await del(ctx, owner, `/clientes/${clienteId}/media/${mediaId}`);
      expect((await get(ctx, owner, `/clientes/${clienteId}/media/${mediaId}/url`)).statusCode).toBe(404);
    });
  });

  it("another client's media: 404 under the caller's own id, 403 under the other id", async () => {
    await withMediaApp(async (ctx) => {
      const a = await setup(ctx);
      const b = await uploaded(ctx);
      expect((await get(ctx, a.owner, `/clientes/${a.clienteId}/media/${b.mediaId}/url`)).statusCode).toBe(404);
      expect((await get(ctx, a.owner, `/clientes/${b.clienteId}/media/${b.mediaId}/url`)).statusCode).toBe(403);
    });
  });
});

describe('DELETE /clientes/:clienteId/media/:mediaId', () => {
  it('lets the uploader delete their own upload and keeps the stored file', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId } = await setup(ctx);
      const collaborator = await login(ctx, 'colaborador_cliente', clienteId);
      ctx.probe.enqueue(photo());
      const created = await upload(ctx, collaborator, clienteId, [filePart(jpeg()), ...okFields]);
      const res = await del(ctx, collaborator, `/clientes/${clienteId}/media/${created.json().id}`);
      expect(res.statusCode).toBe(204);
      expect(ctx.storage.keys()).toHaveLength(1);
      expect((await ctx.db.query('SELECT eliminado_en FROM media WHERE id = $1', [created.json().id])).rows[0].eliminado_en).not.toBeNull();
      expect((await del(ctx, collaborator, `/clientes/${clienteId}/media/${created.json().id}`)).statusCode).toBe(404);
    });
  });

  it("does not let a collaborator or an approver delete other people's uploads; owner and NovaCiel staff can", async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const collaborator = await login(ctx, 'colaborador_cliente', clienteId);
      const approver = await login(ctx, 'aprobador_cliente', clienteId);
      const operator = await login(ctx, 'operador_novaciel', null);
      const admin = await login(ctx, 'administrador_novaciel', null);
      ctx.probe.enqueue(photo());
      const created = await upload(ctx, owner, clienteId, [filePart(jpeg()), ...okFields]);
      const url = `/clientes/${clienteId}/media/${created.json().id}`;
      expect((await del(ctx, collaborator, url)).statusCode).toBe(403);
      expect((await del(ctx, approver, url)).statusCode).toBe(403);
      expect((await ctx.db.query('SELECT eliminado_en FROM media WHERE id = $1', [created.json().id])).rows[0].eliminado_en).toBeNull();
      expect((await del(ctx, operator, url)).statusCode).toBe(204);

      const second = await createMedia(ctx.db, { clienteId, subidoPor: collaborator.user.id });
      expect((await del(ctx, admin, `/clientes/${clienteId}/media/${second.id}`)).statusCode).toBe(204);
      const third = await createMedia(ctx.db, { clienteId, subidoPor: collaborator.user.id });
      expect((await del(ctx, owner, `/clientes/${clienteId}/media/${third.id}`)).statusCode).toBe(204);
    });
  });

  it('media uploaded by the system can only be deleted by the owner or NovaCiel staff', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const collaborator = await login(ctx, 'colaborador_cliente', clienteId);
      const m = await createMedia(ctx.db, { clienteId, subidoPor: null });
      expect((await del(ctx, collaborator, `/clientes/${clienteId}/media/${m.id}`)).statusCode).toBe(403);
      expect((await del(ctx, owner, `/clientes/${clienteId}/media/${m.id}`)).statusCode).toBe(204);
    });
  });

  it("isolation: A cannot delete B's media (404 or 403) and B's rows stay unchanged", async () => {
    await withMediaApp(async (ctx) => {
      const a = await setup(ctx);
      const b = await setup(ctx);
      const m = await createMedia(ctx.db, { clienteId: b.clienteId });
      expect((await del(ctx, a.owner, `/clientes/${a.clienteId}/media/${m.id}`)).statusCode).toBe(404);
      expect((await del(ctx, a.owner, `/clientes/${b.clienteId}/media/${m.id}`)).statusCode).toBe(403);
      expect((await ctx.db.query('SELECT eliminado_en FROM media WHERE id = $1', [m.id])).rows[0].eliminado_en).toBeNull();
      expect((await ctx.db.query(`SELECT 1 FROM auditoria WHERE tabla = 'media' AND fila_id = $1`, [m.id])).rows).toEqual([]);
    });
  });

  it('a CSRF-unsafe DELETE with a wrong Origin is rejected', async () => {
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      const m = await createMedia(ctx.db, { clienteId });
      const res = await ctx.app.inject({
        method: 'DELETE', url: `/clientes/${clienteId}/media/${m.id}`, headers: { ...owner.headers, origin: 'http://evil.example.test', 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});

describe('signed URL through the local file route (development mode)', () => {
  it('serves the uploaded bytes with the right type, and refuses a tampered signature', async () => {
    const storageDir = await mkdtemp(path.join(tempRoot, 'store-'));
    const storage = new LocalFileStorage({ baseDir: storageDir, signingSecret: 's'.repeat(32), publicBaseUrl: ORIGIN });
    const fixture = await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'media', 'sample.jpg'));
    await withMediaApp(async (ctx) => {
      const { clienteId, owner } = await setup(ctx);
      ctx.probe.enqueue(photo({ width: 64, height: 48 }));
      const created = await upload(ctx, owner, clienteId, [filePart(fixture, 'sample.jpg'), ...okFields]);
      expect(created.statusCode).toBe(201);

      const signed = await get(ctx, owner, `/clientes/${clienteId}/media/${created.json().id}/url?ttl=120`);
      expect(signed.statusCode).toBe(200);
      const url = new URL(signed.json().url);
      expect(url.origin).toBe(ORIGIN);
      const file = await ctx.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('image/jpeg');
      expect(file.rawPayload.equals(fixture)).toBe(true);

      const sig = url.searchParams.get('sig')!;
      const tampered = `${url.pathname}?expires=${url.searchParams.get('expires')}&sig=${sig.replace(/.$/, sig.endsWith('0') ? '1' : '0')}`;
      expect((await ctx.app.inject({ method: 'GET', url: tampered })).statusCode).toBe(403);
    }, { storage });
  });
});
