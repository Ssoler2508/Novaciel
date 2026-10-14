import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from './types.js';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  createAutorizacionImagen,
  createCliente,
  createMedia,
  createMediaAutorizacion,
  createUsuario,
} from '../../tests/utils/factories/index.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
// ON DELETE RESTRICT reports restrict_violation, not foreign_key_violation.
const RESTRICT_VIOLATION = '23001';
const NOT_NULL_VIOLATION = '23502';

/** Expects `run` to fail with a PostgreSQL error code, keeping the surrounding transaction usable. */
async function expectDbError(db: Db, code: string, run: () => Promise<unknown>): Promise<void> {
  await db.query('SAVEPOINT expect_error');
  await expect(run()).rejects.toMatchObject({ code });
  await db.query('ROLLBACK TO SAVEPOINT expect_error');
}

describe('media: CHECK constraints', () => {
  it('accepts a photo and a video, and only those types', async () => {
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { tipo: 'foto' })).resolves.toMatchObject({ tipo: 'foto', duracion_ms: null });
      await expect(createMedia(db, { tipo: 'video' })).resolves.toMatchObject({ tipo: 'video', duracion_ms: 5000 });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { tipo: 'audio' as never })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('requires a duration for videos and forbids it for photos', async () => {
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { tipo: 'video', duracionMs: null })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { tipo: 'foto', duracionMs: 1000 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { tipo: 'video', duracionMs: -1 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { tipo: 'video', duracionMs: 0 })).resolves.toMatchObject({ duracion_ms: 0 });
    });
  });

  it('requires positive sizes and dimensions', async () => {
    for (const overrides of [{ tamanoBytes: 0 }, { tamanoBytes: -5 }, { ancho: 0 }, { alto: -1 }]) {
      await withTestTransaction(async (db) => {
        await expect(createMedia(db, overrides)).rejects.toMatchObject({ code: CHECK_VIOLATION });
      });
    }
  });

  it('requires a 32-byte sha256', async () => {
    for (const size of [0, 31, 33]) {
      await withTestTransaction(async (db) => {
        await expect(createMedia(db, { sha256: randomBytes(size) })).rejects.toMatchObject({ code: CHECK_VIOLATION });
      });
    }
  });

  it('keeps the detected mime consistent with the type', async () => {
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { tipo: 'foto', mime: 'video/mp4' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { tipo: 'video', mime: 'image/png' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('requires a non-blank original name (stored only as data)', async () => {
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { nombreOriginal: '  ' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('accepts only the four rights origins, and a licensed file needs its license note', async () => {
    for (const origenDerechos of ['propio', 'cedido_por_cliente', 'material_de_terceros_con_permiso']) {
      await withTestTransaction(async (db) => {
        await expect(createMedia(db, { origenDerechos })).resolves.toMatchObject({ origen_derechos: origenDerechos });
      });
    }
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { origenDerechos: 'licenciado', notaLicencia: 'Licencia ficticia 2026' })).resolves.toBeDefined();
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { origenDerechos: 'licenciado' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { origenDerechos: 'robado' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { notaLicencia: '   ' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  it('rejects a deletion time before the creation time', async () => {
    await withTestTransaction(async (db) => {
      const media = await createMedia(db);
      await expect(
        db.query(`UPDATE media SET eliminado_en = creado_en - interval '1 second' WHERE id = $1`, [media.id]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });
});

describe('media: aparecen_personas', () => {
  it('has no default: omitting it is rejected', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      await expect(
        db.query(
          `INSERT INTO media (cliente_id, tipo, clave_almacenamiento, nombre_original, mime, tamano_bytes, sha256, ancho, alto, origen_derechos)
           VALUES ($1, 'foto', $2, 'a.jpg', 'image/jpeg', 10, $3, 1, 1, 'propio')`,
          [cliente.id, `${cliente.id}/media/${randomUUID()}.jpg`, randomBytes(32)],
        ),
      ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION });
    });
  });

  it('rejects setting it to NULL later and accepts true and false', async () => {
    await withTestTransaction(async (db) => {
      const m = await createMedia(db);
      await expect(db.query('UPDATE media SET aparecen_personas = NULL WHERE id = $1', [m.id])).rejects.toMatchObject({
        code: NOT_NULL_VIOLATION,
      });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { aparecenPersonas: true })).resolves.toMatchObject({ aparecen_personas: true });
    });
  });
});

describe('media: storage key', () => {
  it('must be <cliente_id>/media/<uuid>.<ext> under the row\'s own client', async () => {
    await withTestTransaction(async (db) => {
      const a = await createCliente(db);
      const b = await createCliente(db);
      const bad = [
        `${b.id}/media/${randomUUID()}.jpg`, // another client's prefix
        `${a.id}/media/foto-de-la-fiesta.jpg`, // the original name instead of a uuid
        `${a.id}/${randomUUID()}.jpg`, // missing /media/
        `${a.id}/media/${randomUUID()}`, // no extension
        `${a.id}/media/${randomUUID()}.JPG`, // upper-case extension
        `/${a.id}/media/${randomUUID()}.jpg`,
        `${a.id}/media/../${randomUUID()}.jpg`,
      ];
      for (const claveAlmacenamiento of bad) {
        await db.query('SAVEPOINT s');
        await expect(createMedia(db, { clienteId: a.id, claveAlmacenamiento })).rejects.toMatchObject({ code: CHECK_VIOLATION });
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
      await expect(createMedia(db, { clienteId: a.id })).resolves.toBeDefined();
    });
  });

  it('is unique', async () => {
    await withTestTransaction(async (db) => {
      const first = await createMedia(db);
      await expect(
        createMedia(db, { clienteId: first.cliente_id, claveAlmacenamiento: first.clave_almacenamiento }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });
});

describe('media: description columns', () => {
  const describeSql = `UPDATE media SET descripcion = $2, descrito_en = $3, etiquetas_sugeridas = $4 WHERE id = $1`;

  it('start empty: no description, no suggested tags', async () => {
    await withTestTransaction(async (db) => {
      const m = await createMedia(db);
      const { rows } = await db.query('SELECT descripcion, etiquetas_sugeridas, descrito_en FROM media WHERE id = $1', [m.id]);
      expect(rows[0]).toEqual({ descripcion: null, etiquetas_sugeridas: [], descrito_en: null });
    });
  });

  it('the description and its timestamp are set together', async () => {
    await withTestTransaction(async (db) => {
      const m = await createMedia(db);
      await expectDbError(db, CHECK_VIOLATION, () => db.query(describeSql, [m.id, 'Una descripción', null, []]));
      await expectDbError(db, CHECK_VIOLATION, () => db.query(describeSql, [m.id, null, new Date(), []]));
      await db.query(describeSql, [m.id, 'Una descripción', new Date(), ['a']]);
      await db.query(describeSql, [m.id, null, null, []]);
    });
  });

  it('rejects a blank or over-long description', async () => {
    await withTestTransaction(async (db) => {
      const m = await createMedia(db);
      await expectDbError(db, CHECK_VIOLATION, () => db.query(describeSql, [m.id, '   ', new Date(), []]));
      await expectDbError(db, CHECK_VIOLATION, () => db.query(describeSql, [m.id, 'x'.repeat(4001), new Date(), []]));
      await db.query(describeSql, [m.id, 'x'.repeat(4000), new Date(), []]);
    });
  });

  it('requires suggested tags to be normalized like human tags, at most 30', async () => {
    await withTestTransaction(async (db) => {
      const m = await createMedia(db);
      for (const bad of [['Mayuscula'], [' espacio'], [''], ['a', 'a'], ['x'.repeat(41)], Array.from({ length: 31 }, (_v, i) => `t${i}`)]) {
        await expectDbError(db, CHECK_VIOLATION, () => db.query(describeSql, [m.id, 'ok', new Date(), bad]));
      }
      await db.query(describeSql, [m.id, 'ok', new Date(), Array.from({ length: 30 }, (_v, i) => `t${i}`)]);
    });
  });
});

describe('media: tags', () => {
  it('are stored normalized: lower case, trimmed, non-empty, unique, at most 40 characters', async () => {
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { etiquetas: ['cafe', 'fachada-norte', 'a b'] })).resolves.toMatchObject({
        etiquetas: ['cafe', 'fachada-norte', 'a b'],
      });
    });
    const bad: string[][] = [['Cafe'], [' cafe'], ['cafe '], [''], ['a', 'a'], ['x'.repeat(41)]];
    for (const etiquetas of bad) {
      await withTestTransaction(async (db) => {
        await expect(createMedia(db, { etiquetas })).rejects.toMatchObject({ code: CHECK_VIOLATION });
      });
    }
  });

  it('can be searched by containment, backed by a GIN index', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const both = await createMedia(db, { clienteId: cliente.id, etiquetas: ['cafe', 'fachada'] });
      await createMedia(db, { clienteId: cliente.id, etiquetas: ['cafe'] });
      const { rows } = await db.query(`SELECT id FROM media WHERE cliente_id = $1 AND etiquetas @> $2::text[]`, [
        cliente.id,
        ['cafe', 'fachada'],
      ]);
      expect(rows.map((r) => r.id)).toEqual([both.id]);
      const index = await db.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'media' AND indexname = 'media_etiquetas_idx'`);
      expect(index.rows[0].indexdef).toMatch(/USING gin \(etiquetas\)/);
    });
  });
});

describe('media: duplicates', () => {
  it('rejects the same (cliente_id, sha256), allows it for another client and again after a soft delete', async () => {
    await withTestTransaction(async (db) => {
      const sha256 = randomBytes(32);
      const first = await createMedia(db, { sha256 });
      await expect(createMedia(db, { clienteId: first.cliente_id, sha256 })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      const sha256 = randomBytes(32);
      await createMedia(db, { sha256 });
      await expect(createMedia(db, { sha256 })).resolves.toBeDefined(); // a different (new) client
    });
    await withTestTransaction(async (db) => {
      const sha256 = randomBytes(32);
      const first = await createMedia(db, { sha256 });
      await db.query('UPDATE media SET eliminado_en = now() WHERE id = $1', [first.id]);
      const again = await createMedia(db, { clienteId: first.cliente_id, sha256 });
      expect(again.id).not.toBe(first.id);
      // Deleting the second copy too leaves two deleted rows with the same hash, which is fine.
      await db.query('UPDATE media SET eliminado_en = now() WHERE id = $1', [again.id]);
      await expect(createMedia(db, { clienteId: first.cliente_id, sha256 })).resolves.toBeDefined();
    });
  });
});

describe('media_autorizaciones', () => {
  it('links a media item to an authorization of the same client', async () => {
    await withTestTransaction(async (db) => {
      const media = await createMedia(db, { aparecenPersonas: true });
      const link = await createMediaAutorizacion(db, { mediaId: media.id, clienteId: media.cliente_id });
      expect(link).toMatchObject({ media_id: media.id, cliente_id: media.cliente_id });
    });
  });

  it("rejects linking another client's authorization (composite foreign key)", async () => {
    await withTestTransaction(async (db) => {
      const media = await createMedia(db, { aparecenPersonas: true });
      const other = await createAutorizacionImagen(db); // belongs to a different client
      await expectDbError(db, FK_VIOLATION, () =>
        createMediaAutorizacion(db, { mediaId: media.id, clienteId: media.cliente_id, autorizacionId: other.id }),
      );
      // Claiming the other client in the link row does not help either.
      await expectDbError(db, FK_VIOLATION, () =>
        createMediaAutorizacion(db, { mediaId: media.id, clienteId: other.cliente_id, autorizacionId: other.id }),
      );
      expect((await db.query('SELECT 1 FROM media_autorizaciones')).rows).toHaveLength(0);
    });
  });

  it("rejects linking another client's media", async () => {
    await withTestTransaction(async (db) => {
      const media = await createMedia(db);
      const auth = await createAutorizacionImagen(db);
      await expect(
        createMediaAutorizacion(db, { mediaId: media.id, clienteId: auth.cliente_id, autorizacionId: auth.id }),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
    });
  });

  it('allows each link once and many authorizations per media', async () => {
    await withTestTransaction(async (db) => {
      const media = await createMedia(db, { aparecenPersonas: true });
      const link = await createMediaAutorizacion(db, { mediaId: media.id, clienteId: media.cliente_id });
      await expectDbError(db, UNIQUE_VIOLATION, () =>
        createMediaAutorizacion(db, { mediaId: media.id, clienteId: media.cliente_id, autorizacionId: link.autorizacion_id }),
      );
      await expect(createMediaAutorizacion(db, { mediaId: media.id, clienteId: media.cliente_id })).resolves.toBeDefined();
    });
  });

  it('foreign keys are RESTRICT: linked media and authorizations cannot be removed', async () => {
    await withTestTransaction(async (db) => {
      const media = await createMedia(db, { aparecenPersonas: true });
      const link = await createMediaAutorizacion(db, { mediaId: media.id, clienteId: media.cliente_id });
      await expectDbError(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM media WHERE id = $1', [media.id]));
      await expectDbError(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM autorizaciones_imagen WHERE id = $1', [link.autorizacion_id]));
      await expectDbError(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM clientes WHERE id = $1', [media.cliente_id]));
    });
  });

  it('unlinking is a plain delete of the link row only', async () => {
    await withTestTransaction(async (db) => {
      const media = await createMedia(db, { aparecenPersonas: true });
      const link = await createMediaAutorizacion(db, { mediaId: media.id, clienteId: media.cliente_id });
      await db.query('DELETE FROM media_autorizaciones WHERE media_id = $1 AND autorizacion_id = $2', [media.id, link.autorizacion_id]);
      expect((await db.query('SELECT 1 FROM media WHERE id = $1', [media.id])).rows).toHaveLength(1);
      expect((await db.query('SELECT 1 FROM autorizaciones_imagen WHERE id = $1', [link.autorizacion_id])).rows).toHaveLength(1);
    });
  });
});

describe('media: ownership and uploader', () => {
  it('requires an existing client, and subido_por is optional (NULL = system) but must be a real user', async () => {
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { clienteId: randomUUID() })).rejects.toMatchObject({ code: FK_VIOLATION });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db)).resolves.toMatchObject({ subido_por: null });
      const user = await createUsuario(db);
      await expect(createMedia(db, { subidoPor: user.id })).resolves.toMatchObject({ subido_por: user.id });
    });
    await withTestTransaction(async (db) => {
      await expect(createMedia(db, { subidoPor: randomUUID() })).rejects.toMatchObject({ code: FK_VIOLATION });
    });
  });
});

describe('isolation: media tables', () => {
  it('rows of two clients stay separate by cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const a = await createMedia(db, { aparecenPersonas: true });
      const b = await createMedia(db, { aparecenPersonas: true });
      await createMediaAutorizacion(db, { mediaId: a.id, clienteId: a.cliente_id });
      const mediaOfB = await db.query('SELECT id FROM media WHERE cliente_id = $1', [b.cliente_id]);
      const linksOfB = await db.query('SELECT 1 FROM media_autorizaciones WHERE cliente_id = $1', [b.cliente_id]);
      expect(mediaOfB.rows.map((r) => r.id)).toEqual([b.id]);
      expect(linksOfB.rows).toHaveLength(0);
    });
  });
});
