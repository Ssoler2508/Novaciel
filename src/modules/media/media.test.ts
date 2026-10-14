import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import {
  createAutorizacionImagen,
  createCliente,
  createMedia,
  createMediaAutorizacion,
  createUsuario,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeMediaProbe } from '../../lib/media/probe/fakeMediaProbe.js';
import { MediaProbeError, type ProbeResult } from '../../lib/media/probe/types.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { UnsupportedMediaError } from '../../lib/media/validateMedia.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import {
  AutorizacionNotFoundError,
  DuplicateMediaError,
  FileTooLargeError,
  getMedia,
  getMediaSignedUrl,
  getUsableMedia,
  InvalidMediaInputError,
  linkPersons,
  listMedia,
  MediaNotFoundError,
  softDeleteMedia,
  unlinkPersons,
  updateMediaRights,
  updateMediaTags,
  uploadMedia,
  type UploadMediaDeps,
  type UploadMediaParams,
} from './index.js';

const SISTEMA = { tipo: 'sistema' } as const;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const NAME_SECRET = 'NOMBRE-PRIVADO-DE-LA-PERSONA';
const CONTENT_SECRET = 'CONTENIDO-SECRETO-DEL-ARCHIVO';

const photo = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  kind: 'foto', format: 'jpeg_pipe', mime: 'image/jpeg', width: 640, height: 480, durationMs: null, ...overrides,
});

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'novaciel-media-svc-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A JPEG-looking temp file with unique content (so every one has its own hash). */
async function tempFile(content: Buffer = Buffer.concat([JPEG_MAGIC, randomBytes(64)])): Promise<string> {
  const file = path.join(tmp, `${randomUUID()}.bin`);
  await writeFile(file, content);
  return file;
}

function setup(overrides: Partial<UploadMediaDeps> = {}) {
  const storage = new FakeStorage();
  const probe = new FakeMediaProbe();
  const lines: string[] = [];
  const logger = createLogger('debug', { write: (l: string) => void lines.push(l) });
  return { storage, probe, lines, deps: (db: Db): UploadMediaDeps => ({ db, storage, probe, maxBytes: 1_000_000, logger, ...overrides }) };
}

async function newClient(db: Db): Promise<ClienteId> {
  return asClienteId((await createCliente(db)).id);
}

async function params(overrides: Partial<UploadMediaParams> = {}): Promise<UploadMediaParams> {
  return {
    filePath: await tempFile(),
    originalName: 'foto-de-la-fachada.jpg',
    tags: ['fachada'],
    rights: { origen: 'propio' },
    aparecenPersonas: false,
    ...overrides,
  };
}

describe('uploadMedia', () => {
  it('stores the row, the file and one audit row, under a key that never contains the original name', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      const content = Buffer.concat([JPEG_MAGIC, randomBytes(200)]);
      const file = await tempFile(content);
      s.probe.enqueue(photo());
      const media = await uploadMedia(s.deps(db), clienteId, { ...(await params({ filePath: file })), originalName: 'C:\\Users\\x\\Mis Fotos\\secreto.exe', tags: [' Fachada ', 'CAFE', 'cafe'] }, SISTEMA);

      expect(media.clave_almacenamiento).toMatch(new RegExp(`^${clienteId}/media/[0-9a-f-]{36}\\.jpg$`));
      expect(media.clave_almacenamiento).not.toMatch(/secreto|exe|Mis Fotos/i);
      expect(media).toMatchObject({
        cliente_id: clienteId, tipo: 'foto', mime: 'image/jpeg', tamano_bytes: content.length, ancho: 640, alto: 480,
        duracion_ms: null, etiquetas: ['fachada', 'cafe'], origen_derechos: 'propio', aparecen_personas: false,
        subido_por: null, eliminado_en: null, nombre_original: 'secreto.exe', autorizacion_ids: [],
      });
      expect(media.sha256).toBe(createHash('sha256').update(content).digest('hex'));
      expect((await s.storage.get(media.clave_almacenamiento)).equals(content)).toBe(true);
      expect(s.storage.keys()).toEqual([media.clave_almacenamiento]);

      const audit = await auditRowsFor(db, 'media', media.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ accion: 'crear', cliente_id: clienteId, actor_tipo: 'sistema' });
      expect(JSON.stringify(audit[0]!.datos_despues)).not.toContain('secreto');
    });
  });

  it('records the uploading user, the rights and the people links', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      const user = await createUsuario(db);
      const a1 = await createAutorizacionImagen(db, { clienteId });
      const a2 = await createAutorizacionImagen(db, { clienteId });
      const until = new Date(Date.now() + 30 * DAY_MS);
      s.probe.enqueue(photo());
      const media = await uploadMedia(
        s.deps(db),
        clienteId,
        await params({
          rights: { origen: 'licenciado', notaLicencia: 'Licencia ficticia 2026', derechosHasta: until },
          aparecenPersonas: true,
          autorizacionIds: [a2.id, a1.id, a1.id],
        }),
        { tipo: 'usuario', usuarioId: user.id },
      );
      expect(media).toMatchObject({ subido_por: user.id, origen_derechos: 'licenciado', nota_licencia: 'Licencia ficticia 2026', aparecen_personas: true });
      expect(media.derechos_hasta?.getTime()).toBe(until.getTime());
      expect(media.autorizacion_ids.sort()).toEqual([a1.id, a2.id].sort());
      const audit = await auditRowsFor(db, 'media', media.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_usuario_id: user.id });
    });
  });

  it('stores a video with its duration', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      s.probe.enqueue({ kind: 'video', format: 'mov,mp4,m4a,3gp,3g2,mj2', mime: 'video/mp4', width: 1080, height: 1920, durationMs: 12_345 });
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), randomBytes(40)]);
      const media = await uploadMedia(s.deps(db), clienteId, await params({ filePath: await tempFile(mp4) }), SISTEMA);
      expect(media).toMatchObject({ tipo: 'video', mime: 'video/mp4', duracion_ms: 12_345 });
      expect(media.clave_almacenamiento.endsWith('.mp4')).toBe(true);
    });
  });

  it('rejects a duplicate with the existing id, stores nothing, and allows it after a soft delete or for another client', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      const file = await tempFile();
      s.probe.enqueue(photo(), photo(), photo(), photo());
      const first = await uploadMedia(s.deps(db), clienteId, await params({ filePath: file }), SISTEMA);
      const error = await uploadMedia(s.deps(db), clienteId, await params({ filePath: file }), SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DuplicateMediaError);
      expect(error).toMatchObject({ existingId: first.id });
      expect(s.storage.keys()).toHaveLength(1);

      const other = await newClient(db);
      await expect(uploadMedia(s.deps(db), other, await params({ filePath: file }), SISTEMA)).resolves.toBeDefined();

      await softDeleteMedia(db, clienteId, first.id, SISTEMA);
      const again = await uploadMedia(s.deps(db), clienteId, await params({ filePath: file }), SISTEMA);
      expect(again.id).not.toBe(first.id);
    });
  });

  it('a concurrent upload of the same file that wins the race gives a duplicate error and the stored file is removed', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      const content = Buffer.concat([JPEG_MAGIC, randomBytes(50)]);
      const file = await tempFile(content);
      s.probe.enqueue(photo());
      let winnerId = '';
      // The "other upload" commits its row while this one is storing its file.
      const racing = {
        putFile: async (key: string, filePath: string, contentType?: string) => {
          await s.storage.putFile(key, filePath, contentType);
          winnerId = (await createMedia(db, { clienteId, sha256: createHash('sha256').update(content).digest() })).id;
        },
        delete: (key: string) => s.storage.delete(key),
      };
      const error = await uploadMedia({ ...s.deps(db), storage: racing }, clienteId, await params({ filePath: file }), SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DuplicateMediaError);
      expect(error).toMatchObject({ existingId: winnerId });
      expect(s.storage.keys()).toEqual([]);
    });
  });

  it('rejects an oversized file before hashing or probing', async () => {
    await withTestTransaction(async (db) => {
      const s = setup({ maxBytes: 100 });
      const clienteId = await newClient(db);
      const file = await tempFile(Buffer.concat([JPEG_MAGIC, Buffer.alloc(200)]));
      s.probe.enqueue(photo());
      await expect(uploadMedia(s.deps(db), clienteId, await params({ filePath: file }), SISTEMA)).rejects.toBeInstanceOf(FileTooLargeError);
      expect(s.probe.calls).toEqual([]);
      expect(s.storage.keys()).toEqual([]);
    });
  });

  it('rejects a disallowed type and stores nothing', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      for (const content of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('%PDF-1.4 hello'), Buffer.from('MZ' + 'x'.repeat(60)), Buffer.alloc(0)]) {
        s.probe.enqueue(photo());
        await expect(uploadMedia(s.deps(db), clienteId, await params({ filePath: await tempFile(content), originalName: 'innocent.jpg' }), SISTEMA)).rejects.toBeInstanceOf(UnsupportedMediaError);
      }
      expect(s.probe.calls).toEqual([]);
      expect(s.storage.keys()).toEqual([]);
      expect((await db.query('SELECT 1 FROM media WHERE cliente_id = $1', [clienteId])).rows).toEqual([]);
    });
  });

  it('passes probe failures through and stores nothing', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      s.probe.enqueue({ error: new MediaProbeError('timeout') });
      await expect(uploadMedia(s.deps(db), clienteId, await params(), SISTEMA)).rejects.toMatchObject({ code: 'timeout' });
      expect(s.storage.keys()).toEqual([]);
    });
  });

  it('a database failure after the storage put removes the stored file and leaves no row or audit', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      s.probe.enqueue(photo());
      const before = Number((await db.query('SELECT count(*) AS n FROM auditoria')).rows[0].n);
      // A user id that does not exist: the insert fails on the subido_por foreign key.
      const error = await uploadMedia(s.deps(db), clienteId, await params(), { tipo: 'usuario', usuarioId: randomUUID() }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: '23503' });
      expect(s.storage.keys()).toEqual([]);
      expect((await db.query('SELECT 1 FROM media WHERE cliente_id = $1', [clienteId])).rows).toEqual([]);
      expect(Number((await db.query('SELECT count(*) AS n FROM auditoria')).rows[0].n)).toBe(before);
    });
  });

  it('a failing cleanup is only logged and never hides the original error', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      s.probe.enqueue(photo());
      const storage = { putFile: s.storage.putFile.bind(s.storage), delete: async () => { throw new Error(`disk gone ${NAME_SECRET}`); } };
      const error = await uploadMedia({ ...s.deps(db), storage }, clienteId, await params(), { tipo: 'usuario', usuarioId: randomUUID() }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: '23503' });
      const logs = s.lines.join('');
      expect(logs).toContain('orphan_file');
      expect(logs).not.toContain(NAME_SECRET);
    });
  });

  it('validates the input: tags, name, rights, links', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      const other = await createAutorizacionImagen(db); // another client's authorization
      s.probe.enqueue(photo(), photo(), photo(), photo(), photo(), photo());
      const bad: Partial<UploadMediaParams>[] = [
        { tags: [''] },
        { tags: ['x'.repeat(41)] },
        { originalName: '   ' },
        { rights: { origen: 'licenciado' } },
        { rights: { origen: 'robado' as never } },
        { aparecenPersonas: undefined as never },
        { autorizacionIds: [randomUUID()], aparecenPersonas: true },
        { autorizacionIds: [other.id], aparecenPersonas: true },
        { autorizacionIds: [randomUUID()], aparecenPersonas: false },
      ];
      for (const overrides of bad) {
        const error = await uploadMedia(s.deps(db), clienteId, await params(overrides), SISTEMA).catch((e: unknown) => e);
        expect([InvalidMediaInputError, AutorizacionNotFoundError].some((c) => error instanceof c)).toBe(true);
      }
      expect(s.storage.keys()).toEqual([]);
    });
  });

  it('logs contain no file name, no file content and no path', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      const file = await tempFile(Buffer.concat([JPEG_MAGIC, Buffer.from(CONTENT_SECRET)]));
      s.probe.enqueue(photo(), photo());
      await uploadMedia(s.deps(db), clienteId, await params({ filePath: file, originalName: `${NAME_SECRET}.jpg` }), SISTEMA);
      await uploadMedia(s.deps(db), clienteId, await params({ filePath: file, originalName: `${NAME_SECRET}.jpg` }), SISTEMA).catch(() => undefined);
      await uploadMedia({ ...s.deps(db), maxBytes: 10 }, clienteId, await params({ filePath: file, originalName: `${NAME_SECRET}.jpg` }), SISTEMA).catch(() => undefined);
      const logs = s.lines.join('');
      expect(logs).toContain('media uploaded');
      for (const hidden of [NAME_SECRET, CONTENT_SECRET, tmp, path.basename(file)]) expect(logs).not.toContain(hidden);
    });
  });
});

describe('the usable rule', () => {
  async function world(db: Db) {
    const clienteId = await newClient(db);
    return { clienteId, usable: async (at?: Date) => (await getUsableMedia(db, clienteId, at)).map((m) => m.id) };
  }

  it('no people: usable', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const m = await createMedia(db, { clienteId: w.clienteId, aparecenPersonas: false });
      expect(await w.usable()).toEqual([m.id]);
    });
  });

  it('people but no links: not usable', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      await createMedia(db, { clienteId: w.clienteId, aparecenPersonas: true });
      expect(await w.usable()).toEqual([]);
    });
  });

  it('people with all links valid: usable; one of two links revoked, expired or a minor: not usable', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const good = await createAutorizacionImagen(db, { clienteId: w.clienteId });
      const cases: [string, Parameters<typeof createAutorizacionImagen>[1]][] = [
        ['revoked', { revoked: true }],
        ['expired', { expired: true }],
        ['minor', { esMenor: true }],
      ];
      const ok = await createMedia(db, { clienteId: w.clienteId, aparecenPersonas: true });
      await createMediaAutorizacion(db, { mediaId: ok.id, clienteId: w.clienteId, autorizacionId: good.id });
      const second = await createAutorizacionImagen(db, { clienteId: w.clienteId });
      await createMediaAutorizacion(db, { mediaId: ok.id, clienteId: w.clienteId, autorizacionId: second.id });
      expect(await w.usable()).toEqual([ok.id]);

      for (const [, overrides] of cases) {
        const m = await createMedia(db, { clienteId: w.clienteId, aparecenPersonas: true });
        await createMediaAutorizacion(db, { mediaId: m.id, clienteId: w.clienteId, autorizacionId: good.id });
        const bad = await createAutorizacionImagen(db, { clienteId: w.clienteId, ...overrides });
        await createMediaAutorizacion(db, { mediaId: m.id, clienteId: w.clienteId, autorizacionId: bad.id });
      }
      expect(await w.usable()).toEqual([ok.id]);
    });
  });

  it('rights expired: not usable; rights in the future: usable; soft-deleted: not usable', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const future = await createMedia(db, { clienteId: w.clienteId, derechosHasta: new Date(Date.now() + DAY_MS) });
      await createMedia(db, { clienteId: w.clienteId, derechosHasta: new Date(Date.now() - HOUR_MS) });
      await createMedia(db, { clienteId: w.clienteId, deleted: true });
      expect(await w.usable()).toEqual([future.id]);
    });
  });

  it('uses the database clock by default and an explicit date when given', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const soon = new Date(Date.now() + 2 * HOUR_MS);
      const auth = await createAutorizacionImagen(db, { clienteId: w.clienteId, vigenteHasta: soon });
      const m = await createMedia(db, { clienteId: w.clienteId, aparecenPersonas: true, derechosHasta: new Date(Date.now() + 10 * DAY_MS) });
      await createMediaAutorizacion(db, { mediaId: m.id, clienteId: w.clienteId, autorizacionId: auth.id });
      // Created a moment ago: valid now, without passing any date (database clock).
      expect(await w.usable()).toEqual([m.id]);
      expect(await w.usable(new Date(Date.now() + 3 * HOUR_MS))).toEqual([]); // the authorization has expired by then
      expect(await w.usable(new Date(Date.now() + HOUR_MS))).toEqual([m.id]);
      expect(await w.usable(new Date(Date.now() + 11 * DAY_MS))).toEqual([]); // rights expired
      const viaList = await listMedia(db, w.clienteId, { usable: true });
      expect(viaList.map((x) => x.id)).toEqual([m.id]);
    });
  });
});

describe('listMedia / getMedia', () => {
  it('filters by tipo, by ALL given tags (normalized), and hides deleted media unless asked', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const both = await createMedia(db, { clienteId, etiquetas: ['cafe', 'fachada', 'noche'] });
      const onlyCafe = await createMedia(db, { clienteId, etiquetas: ['cafe'] });
      const video = await createMedia(db, { clienteId, tipo: 'video', etiquetas: ['cafe', 'fachada'] });
      const gone = await createMedia(db, { clienteId, etiquetas: ['cafe', 'fachada'], deleted: true });
      const ids = async (f: Parameters<typeof listMedia>[2]) => (await listMedia(db, clienteId, f)).map((m) => m.id).sort();

      expect(await ids({ tags: ['CAFE'] })).toEqual([both.id, onlyCafe.id, video.id].sort());
      expect(await ids({ tags: [' cafe ', 'Fachada'] })).toEqual([both.id, video.id].sort());
      expect(await ids({ tags: ['cafe', 'fachada', 'noche'] })).toEqual([both.id]);
      expect(await ids({ tags: ['cafe', 'inexistente'] })).toEqual([]);
      expect(await ids({ tipo: 'video' })).toEqual([video.id]);
      expect(await ids({ tipo: 'foto', tags: ['fachada'] })).toEqual([both.id]);
      expect(await ids({ tags: ['fachada'], includeDeleted: true })).toEqual([both.id, video.id, gone.id].sort());
      expect((await ids({})).length).toBe(3);
      expect(await getMedia(db, clienteId, gone.id)).toBeNull();
      expect((await getMedia(db, clienteId, gone.id, { includeDeleted: true }))?.id).toBe(gone.id);
    });
  });
});

describe('edits', () => {
  it('updates tags and rights, audited with before and after, and rejects invalid input', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const m = await createMedia(db, { clienteId, etiquetas: ['uno'] });
      const tags = await updateMediaTags(db, clienteId, m.id, [' DOS ', 'tres'], SISTEMA);
      expect(tags?.etiquetas).toEqual(['dos', 'tres']);
      const until = new Date(Date.now() + DAY_MS);
      const rights = await updateMediaRights(db, clienteId, m.id, { origen: 'licenciado', notaLicencia: 'Nota ficticia', derechosHasta: until }, SISTEMA);
      expect(rights).toMatchObject({ origen_derechos: 'licenciado', nota_licencia: 'Nota ficticia' });
      const audit = await auditRowsFor(db, 'media', m.id);
      expect(audit.map((a) => a.accion)).toEqual(['actualizar_etiquetas', 'actualizar_derechos']);
      expect(audit[0]).toMatchObject({ datos_antes: { etiquetas: ['uno'] }, datos_despues: { etiquetas: ['dos', 'tres'] } });
      expect(audit[1]!.datos_antes).toMatchObject({ origen_derechos: 'propio' });
      await expect(updateMediaTags(db, clienteId, m.id, [''], SISTEMA)).rejects.toBeInstanceOf(InvalidMediaInputError);
      await expect(updateMediaRights(db, clienteId, m.id, { origen: 'licenciado' }, SISTEMA)).rejects.toBeInstanceOf(InvalidMediaInputError);
    });
  });

  it('does not edit deleted or missing media, and writes no audit row for them', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const gone = await createMedia(db, { clienteId, deleted: true });
      expect(await updateMediaTags(db, clienteId, gone.id, ['x'], SISTEMA)).toBeNull();
      expect(await updateMediaRights(db, clienteId, gone.id, { origen: 'propio' }, SISTEMA)).toBeNull();
      expect(await softDeleteMedia(db, clienteId, gone.id, SISTEMA)).toBeNull();
      expect(await updateMediaTags(db, clienteId, randomUUID(), ['x'], SISTEMA)).toBeNull();
      expect(await auditRowsFor(db, 'media', gone.id)).toEqual([]);
    });
  });

  it('links and unlinks people with audit; repeated links are ignored; foreign authorizations are rejected', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const m = await createMedia(db, { clienteId, aparecenPersonas: true });
      const a1 = await createAutorizacionImagen(db, { clienteId });
      const a2 = await createAutorizacionImagen(db, { clienteId });
      expect(await linkPersons(db, clienteId, m.id, [a1.id, a2.id], SISTEMA)).toEqual({ linked: expect.arrayContaining([a1.id, a2.id]) });
      expect(await linkPersons(db, clienteId, m.id, [a1.id], SISTEMA)).toEqual({ linked: [] });
      expect((await getMedia(db, clienteId, m.id))!.autorizacion_ids.sort()).toEqual([a1.id, a2.id].sort());
      expect(await unlinkPersons(db, clienteId, m.id, [a1.id, randomUUID()], SISTEMA)).toEqual({ unlinked: [a1.id] });
      expect(await unlinkPersons(db, clienteId, m.id, [a1.id], SISTEMA)).toEqual({ unlinked: [] });
      expect((await auditRowsFor(db, 'media', m.id)).map((a) => a.accion)).toEqual(['vincular_personas', 'desvincular_personas']);

      const foreign = await createAutorizacionImagen(db);
      await expect(linkPersons(db, clienteId, m.id, [foreign.id], SISTEMA)).rejects.toBeInstanceOf(AutorizacionNotFoundError);
      const noPeople = await createMedia(db, { clienteId, aparecenPersonas: false });
      await expect(linkPersons(db, clienteId, noPeople.id, [a1.id], SISTEMA)).rejects.toBeInstanceOf(InvalidMediaInputError);
    });
  });

  it('soft delete keeps the row and the stored file, and audits', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      s.probe.enqueue(photo());
      const m = await uploadMedia(s.deps(db), clienteId, await params(), SISTEMA);
      const deleted = await softDeleteMedia(db, clienteId, m.id, SISTEMA);
      expect(deleted?.eliminado_en).toBeInstanceOf(Date);
      expect(await getMedia(db, clienteId, m.id)).toBeNull();
      expect(s.storage.has(m.clave_almacenamiento)).toBe(true);
      expect((await auditRowsFor(db, 'media', m.id)).map((a) => a.accion)).toEqual(['crear', 'eliminar']);
      expect(await softDeleteMedia(db, clienteId, m.id, SISTEMA)).toBeNull();
    });
  });
});

describe('getMediaSignedUrl', () => {
  it('gives a signed URL for own media, and refuses deleted, missing and invalid ttl', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = await newClient(db);
      s.probe.enqueue(photo());
      const m = await uploadMedia(s.deps(db), clienteId, await params(), SISTEMA);
      const url = await getMediaSignedUrl({ db, storage: s.storage }, clienteId, m.id, 300);
      expect(url).toContain(encodeURIComponent(m.clave_almacenamiento));
      for (const ttl of [0, -1, 3601, 1.5, Number.NaN]) {
        await expect(getMediaSignedUrl({ db, storage: s.storage }, clienteId, m.id, ttl)).rejects.toBeInstanceOf(InvalidMediaInputError);
      }
      await expect(getMediaSignedUrl({ db, storage: s.storage }, clienteId, randomUUID(), 60)).rejects.toBeInstanceOf(MediaNotFoundError);
      await softDeleteMedia(db, clienteId, m.id, SISTEMA);
      await expect(getMediaSignedUrl({ db, storage: s.storage }, clienteId, m.id, 60)).rejects.toBeInstanceOf(MediaNotFoundError);
    });
  });
});

vi.setConfig({ testTimeout: 20_000 });
