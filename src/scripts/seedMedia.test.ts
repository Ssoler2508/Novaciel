import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { auditRowsFor } from '../../tests/utils/auditRows.js';
import { FakeMediaProbe } from '../lib/media/probe/fakeMediaProbe.js';
import { FfprobeMediaProbe } from '../lib/media/probe/ffprobeMediaProbe.js';
import { isFfprobeAvailable } from '../lib/media/probe/ffprobeAvailable.js';
import type { ProbeResult } from '../lib/media/probe/types.js';
import { FakeStorage } from '../lib/media/storage/fakeStorage.js';
import { getUsableMedia, listMedia } from '../modules/media/index.js';
import { asClienteId } from '../modules/shared/clienteId.js';
import { seedDevelopment, SEED_MEDIA_DIR } from './seedDevelopment.js';

const photo: ProbeResult = { kind: 'foto', format: 'jpeg_pipe', mime: 'image/jpeg', width: 640, height: 480, durationMs: null };
const MAX = 10_000_000;

function mediaDeps() {
  const storage = new FakeStorage();
  const probe = new FakeMediaProbe().enqueue(photo, photo, photo, photo); // 2 files x 2 runs
  return { storage, probe, deps: { storage, probe, maxBytes: MAX } };
}

describe('seed: synthetic media', () => {
  it('uploads two photos through uploadMedia: one without people, one with people linked to the seed authorization', async () => {
    await withTestTransaction(async (db) => {
      const { storage, deps } = mediaDeps();
      const result = await seedDevelopment(db, new Date(), { media: deps });
      expect(result.created).toEqual(expect.arrayContaining(['media: seed-foto-sin-personas.jpg', 'media: seed-foto-con-personas.jpg']));
      expect(result.skipped).toEqual([]);

      const cliente = (await db.query(`SELECT id FROM clientes WHERE nombre_comercial LIKE 'Cafeter%Aurora%'`)).rows[0].id;
      const media = await listMedia(db, asClienteId(cliente));
      expect(media).toHaveLength(2);
      const without = media.find((m) => !m.aparecen_personas)!;
      const withPeople = media.find((m) => m.aparecen_personas)!;
      expect(without).toMatchObject({ tipo: 'foto', etiquetas: ['seed', 'fachada'], origen_derechos: 'propio', subido_por: null, nombre_original: 'seed-foto-sin-personas.jpg' });
      expect(withPeople).toMatchObject({ etiquetas: ['seed', 'barista'] });
      expect(without.autorizacion_ids).toEqual([]);

      const auth = (await db.query(`SELECT id FROM autorizaciones_imagen WHERE cliente_id = $1 AND documento_clave = 'autorizaciones/seed-persona-ficticia.pdf'`, [cliente])).rows[0].id;
      expect(withPeople.autorizacion_ids).toEqual([auth]);

      // Both are usable: the authorization is valid for a year.
      expect((await getUsableMedia(db, asClienteId(cliente))).map((m) => m.id).sort()).toEqual([without.id, withPeople.id].sort());

      for (const m of media) {
        expect(m.clave_almacenamiento).toMatch(new RegExp(`^${cliente}/media/[0-9a-f-]{36}\\.jpg$`));
        expect(storage.has(m.clave_almacenamiento)).toBe(true);
        const audit = (await auditRowsFor(db, 'media', m.id)).filter((a) => a.accion === 'crear');
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actor_tipo: 'sistema', cliente_id: cliente });
      }
    });
  });

  it('is idempotent through the duplicate check: the second run creates nothing and stores nothing', async () => {
    await withTestTransaction(async (db) => {
      const { storage, deps } = mediaDeps();
      await seedDevelopment(db, new Date(), { media: deps });
      const filesAfterFirst = storage.keys().length;
      const second = await seedDevelopment(db, new Date(), { media: deps });
      expect(second.created).toEqual([]);
      expect(second.existing).toEqual(expect.arrayContaining(['media: seed-foto-sin-personas.jpg', 'media: seed-foto-con-personas.jpg']));
      expect(storage.keys()).toHaveLength(filesAfterFirst);
      expect((await db.query('SELECT 1 FROM media')).rows).toHaveLength(2);
    });
  });

  it('skips media and says why when no media dependencies are given', async () => {
    await withTestTransaction(async (db) => {
      const result = await seedDevelopment(db);
      expect(result.skipped).toEqual(['media (not requested)']);
      const skipped = await seedDevelopment(db, new Date(), { mediaSkippedReason: 'media (ffprobe not found at "ffprobe"; install it or set FFPROBE_PATH)' });
      expect(skipped.skipped[0]).toMatch(/ffprobe not found/);
      expect((await db.query('SELECT 1 FROM media')).rows).toEqual([]);
    });
  });
});

describe('isFfprobeAvailable', () => {
  it('is false for a command that does not exist or does not accept -version', () => {
    expect(isFfprobeAvailable(path.join(process.cwd(), 'does-not-exist-ffprobe'))).toBe(false);
    expect(isFfprobeAvailable('definitely-not-a-real-command-7781')).toBe(false);
    expect(isFfprobeAvailable(process.execPath)).toBe(false); // node exits non-zero for "-version"
  });
});

// Optional: the committed seed photos must be valid for the REAL ffprobe. Skipped when it is missing.
describe.skipIf(!isFfprobeAvailable('ffprobe'))('seed photos with the real ffprobe (optional integration)', () => {
  it('isFfprobeAvailable is true for the real ffprobe', () => {
    expect(isFfprobeAvailable('ffprobe')).toBe(true);
  });

  it.each(['seed-foto-sin-personas.jpg', 'seed-foto-con-personas.jpg'])('%s is a valid 640x480 JPEG', async (file) => {
    const probe = new FfprobeMediaProbe({ path: 'ffprobe', timeoutMs: 15_000 });
    await expect(probe.probe(path.join(SEED_MEDIA_DIR, file))).resolves.toMatchObject({ kind: 'foto', mime: 'image/jpeg', width: 640, height: 480, durationMs: null });
  });

  it('the whole seed works with real ffprobe and a fake storage, and a second run creates nothing', async () => {
    await withTestTransaction(async (db) => {
      const deps = { storage: new FakeStorage(), probe: new FfprobeMediaProbe({ path: 'ffprobe', timeoutMs: 15_000 }), maxBytes: MAX };
      const first = await seedDevelopment(db, new Date(), { media: deps });
      expect(first.created.filter((c) => c.startsWith('media:'))).toHaveLength(2);
      expect((await seedDevelopment(db, new Date(), { media: deps })).created).toEqual([]);
    });
  });
});
