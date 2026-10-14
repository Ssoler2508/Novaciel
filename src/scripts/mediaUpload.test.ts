import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { auditRowsFor } from '../../tests/utils/auditRows.js';
import { createAutorizacionImagen, createCliente } from '../../tests/utils/factories/index.js';
import { FakeMediaProbe } from '../lib/media/probe/fakeMediaProbe.js';
import { MediaProbeError, type ProbeResult } from '../lib/media/probe/types.js';
import { FakeStorage } from '../lib/media/storage/fakeStorage.js';
import { asClienteId } from '../modules/shared/clienteId.js';
import { parseMediaUploadArgs } from './mediaUploadArgs.js';
import { runMediaUpload } from './mediaUploadCore.js';
import { assertMediaUploadAllowed, confirmMediaUploadDatabase } from './mediaUploadGuard.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const AUTH_ID = '223e4567-e89b-42d3-a456-426614174001';
const NAME_SECRET = 'NOMBRE-PRIVADO-DE-LA-PERSONA';
const photo: ProbeResult = { kind: 'foto', format: 'jpeg_pipe', mime: 'image/jpeg', width: 800, height: 600, durationMs: null };

let tmp: string;
let file: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'novaciel-mediaupload-'));
  file = path.join(tmp, `${NAME_SECRET}.jpg`);
  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2, 3]));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('parseMediaUploadArgs', () => {
  it('parses every option, in both syntaxes', () => {
    const a = parseMediaUploadArgs(['--cliente', ID, '--file', file, '--tags', ' Cafe, fachada ', '--aparece-gente', 'true', '--autorizacion', AUTH_ID]);
    expect(a).toMatchObject({ clienteId: ID, filePath: path.resolve(file), tags: ['Cafe', 'fachada'], aparecenPersonas: true, autorizacionId: AUTH_ID });
    const b = parseMediaUploadArgs([`--cliente=${ID}`, `--file=${file}`, '--aparece-gente=false']);
    expect(b).toMatchObject({ aparecenPersonas: false, tags: [] });
    expect(b.autorizacionId).toBeUndefined();
  });

  it('rejects missing, repeated, unknown and invalid options without echoing values', () => {
    const base = ['--cliente', ID, '--file', file, '--aparece-gente', 'false'];
    const without = (flag: string) => {
      const i = base.indexOf(flag);
      return [...base.slice(0, i), ...base.slice(i + 2)];
    };
    for (const flag of ['--cliente', '--file', '--aparece-gente']) expect(() => parseMediaUploadArgs(without(flag))).toThrow(new RegExp(flag));
    const bad: [string[], RegExp][] = [
      [[...base, '--cliente', ID], /more than once/],
      [[...base, '--force', 'x'], /Unknown option/],
      [[...base, 'positional'], /Unexpected argument/],
      [['--cliente', 'not-a-uuid-secret', '--file', file, '--aparece-gente', 'false'], /--cliente must be/],
      [['--cliente', ID, '--file', file, '--aparece-gente', 'maybe-secret'], /--aparece-gente must be/],
      [[...base, '--autorizacion', 'nope-secret'], /--autorizacion must be/],
      [['--cliente', ID, '--file', path.join(tmp, 'missing-secret.jpg'), '--aparece-gente', 'false'], /--file must be/],
      [['--cliente', ID, '--file', tmp, '--aparece-gente', 'false'], /--file must be/], // a folder
      [[...base, '--tags'], /needs a value/],
    ];
    for (const [argv, pattern] of bad) {
      let message = '';
      try {
        parseMediaUploadArgs(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(pattern);
      expect(message).not.toMatch(/secret/);
    }
  });
});

describe('media:upload guard', () => {
  const url = (name: string) => `postgresql://fakeuser:fakepassword@localhost:5432/${name}`;

  it('accepts a development database, refuses production and *_test (also percent-encoded), and never echoes URLs', () => {
    expect(assertMediaUploadAllowed({ nodeEnv: 'development', databaseUrl: url('fake_dev') })).toBe('fake_dev');
    expect(() => assertMediaUploadAllowed({ nodeEnv: 'production', databaseUrl: url('fake_dev') })).toThrow(/production/);
    expect(() => assertMediaUploadAllowed({ nodeEnv: 'development', databaseUrl: url('fake_test') })).toThrow(/"fake_test"/);
    expect(() => assertMediaUploadAllowed({ nodeEnv: 'development', databaseUrl: url('fake%5Ftest') })).toThrow(/"fake_test"/);
    let message = '';
    try {
      assertMediaUploadAllowed({ nodeEnv: 'development', databaseUrl: 'not a url, secret-token' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not a valid URL/);
    expect(message).not.toContain('secret-token');
    expect(() => assertMediaUploadAllowed({ nodeEnv: 'development', databaseUrl: 'postgresql://u:p@localhost:5432/' })).toThrow(/no database name/);
  });

  it("refuses when the server's own database name ends in _test", async () => {
    const fakeDb = (name: string) => ({ query: async () => ({ rows: [{ name }] }) }) as never;
    await expect(confirmMediaUploadDatabase(fakeDb('fake_test'))).rejects.toThrow(/"fake_test"/);
    await expect(confirmMediaUploadDatabase(fakeDb('fake_dev'))).resolves.toBe('fake_dev');
  });
});

describe('runMediaUpload (fake storage and probe)', () => {
  function setup() {
    return { storage: new FakeStorage(), probe: new FakeMediaProbe() };
  }

  it('uploads through uploadMedia as sistema and reports the technical data without the file path', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = asClienteId((await createCliente(db)).id);
      const auth = await createAutorizacionImagen(db, { clienteId });
      s.probe.enqueue(photo);
      const result = await runMediaUpload(
        { db, ...s, maxBytes: 1_000_000 },
        { clienteId, filePath: file, tags: ['cafe'], aparecenPersonas: true, autorizacionId: auth.id },
      );
      expect(result.ok).toBe(true);
      const text = result.lines.join('\n');
      expect(text).toMatch(/Uploaded media [0-9a-f-]{36}/);
      expect(text).toContain('800x600');
      expect(text).toContain('linked authorizations: 1');
      expect(text).not.toContain(tmp);
      const row = (await db.query('SELECT id, nombre_original, subido_por, clave_almacenamiento FROM media WHERE cliente_id = $1', [clienteId])).rows[0];
      expect(row).toMatchObject({ nombre_original: `${NAME_SECRET}.jpg`, subido_por: null });
      expect(row.clave_almacenamiento).not.toContain(NAME_SECRET);
      expect(s.storage.has(row.clave_almacenamiento)).toBe(true);
      const audit = await auditRowsFor(db, 'media', row.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_tipo: 'sistema', accion: 'crear' });
    });
  });

  it('answers with one clean line for duplicates, bad types, unknown clients, unknown authorizations and a missing ffprobe', async () => {
    await withTestTransaction(async (db) => {
      const s = setup();
      const clienteId = asClienteId((await createCliente(db)).id);
      const args = { clienteId, filePath: file, tags: [], aparecenPersonas: false };
      s.probe.enqueue(photo, photo);
      expect((await runMediaUpload({ db, ...s, maxBytes: 1_000_000 }, args)).ok).toBe(true);
      const dup = await runMediaUpload({ db, ...s, maxBytes: 1_000_000 }, args);
      expect(dup).toMatchObject({ ok: false });
      expect(dup.lines).toHaveLength(1);
      expect(dup.lines[0]).toMatch(/already in the library \(id [0-9a-f-]{36}\)/);

      const text = path.join(tmp, 'notes.jpg');
      await writeFile(text, 'hello world, not an image');
      expect((await runMediaUpload({ db, ...s, maxBytes: 1_000_000 }, { ...args, filePath: text })).lines[0]).toMatch(/not an accepted photo or video/);

      const other = asClienteId((await createCliente(db)).id);
      s.probe.enqueue(photo);
      const foreign = await createAutorizacionImagen(db); // belongs to another client
      expect((await runMediaUpload({ db, ...s, maxBytes: 1_000_000 }, { ...args, clienteId: other, aparecenPersonas: true, autorizacionId: foreign.id })).lines[0]).toMatch(/authorization does not exist/);

      expect((await runMediaUpload({ db, ...s, maxBytes: 1_000_000 }, { ...args, clienteId: asClienteId(ID) })).lines).toEqual(['That client does not exist']);

      s.probe.enqueue({ error: new MediaProbeError('not_found') });
      const other2 = asClienteId((await createCliente(db)).id);
      expect((await runMediaUpload({ db, ...s, maxBytes: 1_000_000 }, { ...args, clienteId: other2 })).lines[0]).toMatch(/install it or set FFPROBE_PATH/);

      expect((await runMediaUpload({ db, ...s, maxBytes: 5 }, { ...args, clienteId: other2 })).lines[0]).toMatch(/larger than the allowed 5 bytes/);
    });
  });
});
