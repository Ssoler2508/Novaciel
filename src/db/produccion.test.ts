import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  createCliente,
  createGuion,
  createMedia,
  createPieza,
  createPlanSemanal,
  createProduccion,
  createProduccionArchivo,
  moverPieza,
} from '../../tests/utils/factories/index.js';
import type { Db } from './types.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
// ON DELETE RESTRICT reports restrict_violation, not foreign_key_violation.
const RESTRICT_VIOLATION = '23001';

/** Expects `run` to fail, keeping the surrounding transaction usable. `match` is a PG error code or a message pattern. */
async function expectFails(db: Db, match: string | RegExp, run: () => Promise<unknown>): Promise<void> {
  await db.query('SAVEPOINT expect_fails');
  const assertion = expect(run()).rejects;
  await (typeof match === 'string' ? assertion.toMatchObject({ code: match }) : assertion.toThrow(match));
  await db.query('ROLLBACK TO SAVEPOINT expect_fails');
}

/** A piece of an approved plan with its brief, in guion_listo: ready for a first production. */
async function readyPiece(db: Db, clienteId?: string) {
  const guion = await createGuion(db, clienteId ? { clienteId } : {});
  await moverPieza(db, guion.pieza_id, 'guion_listo');
  return { clienteId: guion.cliente_id, piezaId: guion.pieza_id, guion };
}

/** Raw insert, to try combinations the factory would not build. */
async function insertProduccion(
  db: Db,
  p: { clienteId: string; piezaId: string; guionId: string; version?: number; red?: string; esActual?: boolean; hashPieza?: Buffer; hashVersion?: string; hashtags?: (string | null)[]; alts?: (string | null)[] },
) {
  return db.query(
    `INSERT INTO producciones (cliente_id, pieza_id, guion_id, version, es_actual, red, texto_publicacion, hashtags, textos_alternativos, hash_version, hash_pieza)
     VALUES ($1, $2, $3, $4, $5, $6, 'Texto ficticio', $7, $8, $9, $10) RETURNING id`,
    [
      p.clienteId,
      p.piezaId,
      p.guionId,
      p.version ?? 1,
      p.esActual ?? true,
      p.red ?? 'instagram',
      p.hashtags ?? ['#ficticio'],
      p.alts ?? ['Alt ficticio'],
      p.hashVersion ?? 'np1',
      p.hashPieza ?? randomBytes(32),
    ],
  );
}

describe('producciones: who may point at what', () => {
  it('stores a production with its files, in order, for a piece of an approved plan', async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      const [m1, m2] = [await createMedia(db, { clienteId: w.clienteId }), await createMedia(db, { clienteId: w.clienteId })];
      const produccion = await createProduccion(db, {
        piezaId: w.piezaId,
        hashtags: ['#cafe', '#origen'],
        ubicacion: 'Nuestro barrio',
        archivos: [{ mediaId: m1.id }, { mediaId: m2.id, ancho: 1080, alto: 1350 }],
      });
      expect(produccion).toMatchObject({ version: 1, es_actual: true, cliente_id: w.clienteId, guion_id: w.guion.id, red: 'instagram', hash_version: 'np1', ubicacion: 'Nuestro barrio' });
      expect(produccion.hash_pieza).toHaveLength(32);
      expect(produccion.textos_alternativos).toHaveLength(2);
      const files = (await db.query('SELECT orden, media_id, mime FROM producciones_archivos WHERE produccion_id = $1 ORDER BY orden', [produccion.id])).rows;
      expect(files).toEqual([
        { orden: 1, media_id: m1.id, mime: 'image/jpeg' },
        { orden: 2, media_id: m2.id, mime: 'image/jpeg' },
      ]);
      await db.query('SET CONSTRAINTS producciones_completa IMMEDIATE'); // a complete production passes the commit check
    });
  });

  it("cannot point to another client's piece, brief or media", async () => {
    await withTestTransaction(async (db) => {
      const a = await readyPiece(db);
      const b = await readyPiece(db);
      const mediaB = await createMedia(db, { clienteId: b.clienteId });

      // Piece of B under client A (the insert trigger answers first; the composite FK is the second layer).
      await expectFails(db, /piece does not exist for this client/, () => insertProduccion(db, { clienteId: a.clienteId, piezaId: b.piezaId, guionId: b.guion.id }));
      // Brief of B for the piece of A (the trigger answers first; the composite FK is the second layer).
      await expectFails(db, /must be the current brief of the piece/, () => insertProduccion(db, { clienteId: a.clienteId, piezaId: a.piezaId, guionId: b.guion.id }));

      const produccionA = await createProduccion(db, { piezaId: a.piezaId });
      // Media of B as the source of a file of A, and a file written under B's client id on A's production.
      await expectFails(db, FK_VIOLATION, () => createProduccionArchivo(db, { produccionId: produccionA.id, clienteId: a.clienteId, orden: 2, mediaId: mediaB.id }));
      await expectFails(db, /only be added to the current production/, () => createProduccionArchivo(db, { produccionId: produccionA.id, clienteId: b.clienteId, orden: 2 }));
    });
  });

  it('restricts deleting what a production uses', async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      const media = await createMedia(db, { clienteId: w.clienteId });
      await createProduccion(db, { piezaId: w.piezaId, archivos: [{ mediaId: media.id }] });
      await expectFails(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM media WHERE id = $1', [media.id]));
      await expectFails(db, /a brief cannot be deleted/, () => db.query('DELETE FROM guiones WHERE id = $1', [w.guion.id]));
      await expectFails(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM piezas WHERE id = $1', [w.piezaId]));
    });
  });
});

describe('producciones: versions', () => {
  it('has only one current production per piece, with consecutive versions and a current-born row', async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      const base = { clienteId: w.clienteId, piezaId: w.piezaId, guionId: w.guion.id };
      await expectFails(db, /next version of this piece is 1/, () => insertProduccion(db, { ...base, version: 2 }));
      await expectFails(db, /born current/, () => insertProduccion(db, { ...base, esActual: false }));
      await createProduccion(db, { piezaId: w.piezaId });
      // A second current row is refused even with the right next version.
      await expectFails(db, UNIQUE_VIOLATION, () => insertProduccion(db, { ...base, version: 2 }));
      await db.query('UPDATE producciones SET es_actual = false WHERE pieza_id = $1', [w.piezaId]);
      await expectFails(db, /next version of this piece is 2/, () => insertProduccion(db, { ...base, version: 1 }));
      await expectFails(db, /next version of this piece is 2/, () => insertProduccion(db, { ...base, version: 3 }));
    });
  });

  it('keeps the old version readable, with its files, when a new one is made', async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      const v1 = await createProduccion(db, { piezaId: w.piezaId, textoPublicacion: 'primera', archivos: [{}, {}] });
      const v2 = await createProduccion(db, { piezaId: w.piezaId, textoPublicacion: 'segunda' });
      expect(v2.version).toBe(2);
      const rows = (await db.query('SELECT version, es_actual, texto_publicacion FROM producciones WHERE pieza_id = $1 ORDER BY version', [w.piezaId])).rows;
      expect(rows).toEqual([
        { version: 1, es_actual: false, texto_publicacion: 'primera' },
        { version: 2, es_actual: true, texto_publicacion: 'segunda' },
      ]);
      expect((await db.query('SELECT 1 FROM producciones_archivos WHERE produccion_id = $1', [v1.id])).rows).toHaveLength(2);
    });
  });
});

describe('producciones: never edited', () => {
  it('allows only es_actual true -> false; every other change, the way back and deleting are refused', async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      const produccion = await createProduccion(db, { piezaId: w.piezaId });
      for (const [column, value] of [
        ['version', 5],
        ['red', 'facebook'],
        ['texto_publicacion', 'otro texto'],
        ['hashtags', ['#otro']],
        ['textos_alternativos', ['otro alt']],
        ['ubicacion', 'otro lugar'],
        ['hash_pieza', randomBytes(32)],
        ['creado_en', new Date(0)],
      ] as const) {
        await expectFails(db, /a production is never edited/, () => db.query(`UPDATE producciones SET ${column} = $2 WHERE id = $1`, [produccion.id, value]));
      }
      await expectFails(db, /cannot be deleted/, () => db.query('DELETE FROM producciones WHERE id = $1', [produccion.id]));

      await db.query('UPDATE producciones SET es_actual = false WHERE id = $1', [produccion.id]);
      await expectFails(db, /cannot become current again/, () => db.query('UPDATE producciones SET es_actual = true WHERE id = $1', [produccion.id]));
      expect((await db.query('SELECT es_actual FROM producciones WHERE id = $1', [produccion.id])).rows[0].es_actual).toBe(false);
    });
  });

  it('keeps the files fixed too, and adds them only to the current production', async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      const produccion = await createProduccion(db, { piezaId: w.piezaId });
      await expectFails(db, /never changed/, () => db.query('UPDATE producciones_archivos SET ancho = 1 WHERE produccion_id = $1', [produccion.id]));
      await expectFails(db, /never changed/, () => db.query('DELETE FROM producciones_archivos WHERE produccion_id = $1', [produccion.id]));
      await db.query('UPDATE producciones SET es_actual = false WHERE id = $1', [produccion.id]);
      await expectFails(db, /only be added to the current production/, () =>
        createProduccionArchivo(db, { produccionId: produccion.id, clienteId: w.clienteId, orden: 2 }),
      );
    });
  });
});

describe('producciones: where a production can be born', () => {
  it('is refused when the plan is not approved or is discarded', async () => {
    await withTestTransaction(async (db) => {
      for (const estado of ['borrador', 'propuesto', 'descartado'] as const) {
        const w = await readyPiece(db);
        await db.query('UPDATE planes_semanales SET estado = $2 WHERE id = (SELECT plan_id FROM piezas WHERE id = $1)', [w.piezaId, estado]);
        await expectFails(db, /plan of the piece is not approved/, () => insertProduccion(db, { clienteId: w.clienteId, piezaId: w.piezaId, guionId: w.guion.id }));
      }
    });
  });

  it('is accepted in guion_listo, en_produccion and en_control_calidad and refused elsewhere', async () => {
    await withTestTransaction(async (db) => {
      const insert = (w: Awaited<ReturnType<typeof readyPiece>>) => insertProduccion(db, { clienteId: w.clienteId, piezaId: w.piezaId, guionId: w.guion.id });
      for (const hacia of ['en_produccion', 'en_control_calidad'] as const) {
        const w = await readyPiece(db);
        if (hacia === 'en_control_calidad') await moverPieza(db, w.piezaId, 'en_produccion');
        await moverPieza(db, w.piezaId, hacia);
        await insert(w);
      }
      await insert(await readyPiece(db)); // guion_listo

      // plan_aprobado (the brief exists, the piece has not moved yet), paused, and past the produced state.
      const early = await createGuion(db);
      await expectFails(db, /needs the piece in guion_listo, en_produccion or en_control_calidad, not plan_aprobado/, () =>
        insertProduccion(db, { clienteId: early.cliente_id, piezaId: early.pieza_id, guionId: early.id }),
      );
      const paused = await readyPiece(db);
      await moverPieza(db, paused.piezaId, 'pausada');
      await expectFails(db, /not pausada/, () => insert(paused));
      const reviewed = await readyPiece(db);
      for (const estado of ['en_produccion', 'en_control_calidad', 'revision_novaciel'] as const) await moverPieza(db, reviewed.piezaId, estado);
      await expectFails(db, /not revision_novaciel/, () => insert(reviewed));
    });
  });

  it("must use the piece's current brief and the piece's network", async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      // Another piece of the same client and plan, with its own brief.
      const planId = (await db.query<{ plan_id: string }>('SELECT plan_id FROM piezas WHERE id = $1', [w.piezaId])).rows[0]!.plan_id;
      const otherPieza = await createPieza(db, { clienteId: w.clienteId, planId, estado: 'plan_aprobado' });
      const other = { guion: await createGuion(db, { piezaId: otherPieza.id }) };
      // The brief of another piece of the same client.
      await expectFails(db, /must be the current brief of the piece/, () => insertProduccion(db, { clienteId: w.clienteId, piezaId: w.piezaId, guionId: other.guion.id }));
      // The network must be the piece's.
      await expectFails(db, /network must be the piece network/, () => insertProduccion(db, { clienteId: w.clienteId, piezaId: w.piezaId, guionId: w.guion.id, red: 'facebook' }));
      // A retired (older) brief is not the current one.
      await moverPieza(db, w.piezaId, 'en_produccion');
      await db.query('UPDATE guiones SET es_actual = false WHERE id = $1', [w.guion.id]);
      await expectFails(db, /must be the current brief of the piece/, () => insertProduccion(db, { clienteId: w.clienteId, piezaId: w.piezaId, guionId: w.guion.id }));
    });
  });

  it('refuses a piece that does not exist', async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      await expectFails(db, /piece does not exist for this client/, () => insertProduccion(db, { clienteId: w.clienteId, piezaId: randomUUID(), guionId: w.guion.id }));
    });
  });
});

describe('producciones: content and files', () => {
  it('enforces the hash lengths, the version tag, and arrays without null elements', async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      const base = { clienteId: w.clienteId, piezaId: w.piezaId, guionId: w.guion.id };
      await expectFails(db, CHECK_VIOLATION, () => insertProduccion(db, { ...base, hashPieza: randomBytes(31) }));
      await expectFails(db, CHECK_VIOLATION, () => insertProduccion(db, { ...base, hashPieza: randomBytes(33) }));
      await expectFails(db, CHECK_VIOLATION, () => insertProduccion(db, { ...base, hashVersion: 'np2' }));
      await expectFails(db, CHECK_VIOLATION, () => insertProduccion(db, { ...base, hashtags: ['#a', null] }));
      await expectFails(db, CHECK_VIOLATION, () => insertProduccion(db, { ...base, alts: [null] }));
      const produccion = await createProduccion(db, { piezaId: w.piezaId });
      await expectFails(db, CHECK_VIOLATION, () => createProduccionArchivo(db, { produccionId: produccion.id, clienteId: w.clienteId, orden: 2, sha256: randomBytes(31) }));
    });
  });

  it('enforces the storage key format: <cliente_id>/producidos/<uuid>.<ext>, in the client\'s own prefix', async () => {
    await withTestTransaction(async (db) => {
      const w = await readyPiece(db);
      const other = (await createCliente(db)).id;
      const produccion = await createProduccion(db, { piezaId: w.piezaId });
      const file = (clave: string, orden: number, mime = 'image/jpeg') =>
        createProduccionArchivo(db, { produccionId: produccion.id, clienteId: w.clienteId, orden, claveAlmacenamiento: clave, mime });
      const uuid = () => randomUUID();

      const ok = [`${w.clienteId}/producidos/${uuid()}.jpg`, `${w.clienteId}/producidos/${uuid()}.png`, `${w.clienteId}/producidos/${uuid()}.webp`];
      for (const [i, clave] of ok.entries()) {
        const mime = ['image/jpeg', 'image/png', 'image/webp'][i]!;
        await expect(file(clave, i + 2, mime)).resolves.toMatchObject({ clave_almacenamiento: clave });
      }
      await expect(file(`${w.clienteId}/producidos/${uuid()}.mp4`, 5, 'video/mp4')).resolves.toBeDefined();

      const bad = [
        `${other}/producidos/${uuid()}.jpg`, // another client's prefix
        `${w.clienteId}/media/${uuid()}.jpg`, // not the production folder
        `${w.clienteId}/producidos/${uuid()}.gif`, // extension outside the list
        `${w.clienteId}/producidos/${uuid()}.JPG`, // upper case
        `${w.clienteId}/producidos/${uuid().toUpperCase()}.jpg`, // upper case id
        `${w.clienteId}/producidos/original-name.jpg`, // an original name instead of a uuid
        `${w.clienteId}/producidos/${uuid()}`, // no extension
        `${w.clienteId}/producidos/extra/${uuid()}.jpg`, // nested
        `${w.clienteId}/producidos/../${uuid()}.jpg`, // path trick
        `/${w.clienteId}/producidos/${uuid()}.jpg`, // leading slash
        `${w.clienteId}/producidos/${uuid()}.jpg `, // trailing space
        `producidos/${uuid()}.jpg`, // no client prefix
      ];
      for (const [i, clave] of bad.entries()) {
        await expectFails(db, CHECK_VIOLATION, () => file(clave, 10 + i));
      }
      // The extension must match the mime, and a key can be used once.
      await expectFails(db, CHECK_VIOLATION, () => file(`${w.clienteId}/producidos/${uuid()}.jpg`, 30, 'image/png'));
      await expectFails(db, UNIQUE_VIOLATION, () => file(ok[0]!, 31));
    });
  });
});

describe('producciones: complete at commit', () => {
  it('needs at least one file, files numbered 1 to n, and one alt text per file', async () => {
    await withTestTransaction(async (db) => {
      const check = () => db.query('SET CONSTRAINTS producciones_completa IMMEDIATE');
      const w = await readyPiece(db);
      // Each scenario runs in its own savepoint, so its pending commit check is discarded with it.
      const scenario = (pattern: RegExp, make: () => Promise<unknown>) =>
        expectFails(db, pattern, async () => {
          await make();
          await check();
        });

      await scenario(/at least one file/, () => createProduccion(db, { piezaId: w.piezaId, archivos: [] }));
      await scenario(/one alt text per file/, () => createProduccion(db, { piezaId: w.piezaId, archivos: [{}], textosAlternativos: ['uno', 'dos'] }));
      await scenario(/one alt text per file/, () => createProduccion(db, { piezaId: w.piezaId, archivos: [{}, {}], textosAlternativos: ['solo uno'] }));
      // A gap in the numbering: files 1 and 3.
      await scenario(/numbered 1 to n without gaps/, async () => {
        const gap = await createProduccion(db, { piezaId: w.piezaId, archivos: [{}], textosAlternativos: ['uno', 'tres'] });
        await createProduccionArchivo(db, { produccionId: gap.id, clienteId: w.clienteId, orden: 3 });
      });

      await createProduccion(db, { piezaId: w.piezaId, archivos: [{}, {}, {}] });
      await check(); // complete: passes
    });
  });
});
