import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import {
  createActores,
  createAprobacion,
  createPiezaAprobable,
  createProduccion,
  createUsuarioConRol,
  moverPieza,
  type Actores,
  type PiezaAprobable,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { ProduccionHechoVencidoError, ProduccionMediaNoUsableError } from '../produccion/errors.js';
import { asClienteId } from '../shared/clienteId.js';
import { reabrirPieza, registrarDecision } from './aprobacionesService.js';
import {
  ArchivoAlteradoError,
  HashDesactualizadoError,
  HashPiezaNoCoincideError,
  PermisoDenegadoError,
  PiezaNoPublicableError,
  SinAprobacionVigenteError,
} from './errors.js';
import { assertPublicable } from './publicable.js';

// THE CENTRAL RULE (rule 1): no piece is published without a recorded internal approval and a recorded
// client approval of its exact current files and copy. One test per way to break it; each ends with
// assertPublicable refusing. A piece that "got to aprobada" without approvals is built through the test
// factory, which turns the test-only switch of the database guard on for its own insert. A disabled trigger
// is re-enabled by the rollback that ends every test (DDL is transactional).

interface X {
  db: Db;
  storage: FakeStorage;
  w: PiezaAprobable;
  actores: Actores;
  clienteId: ReturnType<typeof asClienteId>;
  deps: { db: Db; storage: FakeStorage };
}

async function world(db: Db, archivos = 2): Promise<X> {
  const storage = new FakeStorage();
  const w = await createPiezaAprobable(db, storage, { archivos });
  const actores = await createActores(db, w.clienteId);
  return { db, storage, w, actores, clienteId: asClienteId(w.clienteId), deps: { db, storage } };
}

const interno = (x: X, hash = x.w.hashHex) => registrarDecision({ db: x.db }, x.clienteId, x.w.piezaId, x.actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: hash });
const cliente = (x: X, hash = x.w.hashHex) => registrarDecision({ db: x.db }, x.clienteId, x.w.piezaId, x.actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: hash });

/** Both levels approved through the services: the piece is `aprobada`. */
async function aprobada(db: Db, archivos = 2): Promise<X> {
  const x = await world(db, archivos);
  await interno(x);
  await cliente(x);
  return x;
}

/** Disables the immutability trigger of producciones for the rest of this test transaction (the rollback restores it). */
async function sinInmutabilidad(db: Db) {
  await db.query('SET CONSTRAINTS ALL IMMEDIATE'); // flush pending deferred events, or ALTER TABLE refuses
  await db.query('ALTER TABLE producciones DISABLE TRIGGER producciones_before_update_delete');
}

/** The piece sits in `aprobada` although the records do not say so (a corrupted state), built by the factory. */
async function forzarAprobada(x: X, desde: string[]) {
  for (const estado of desde) await moverPieza(x.db, x.w.piezaId, estado);
}

describe('assertPublicable: the positive case', () => {
  it('passes when both levels approved the current hash, the files are intact and the facts and media are valid', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).resolves.toEqual({ produccionId: x.w.produccionId, version: 1, hashPieza: x.w.hashHex });
    });
  });

  it('also passes once the piece is programada, and never changes anything', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      await moverPieza(db, x.w.piezaId, 'programada'); // through the real guard? no: the factory switch; the guard itself is tested in guardaAprobacion.test.ts
      const before = await db.query('SELECT estado, version_estado FROM piezas WHERE id = $1', [x.w.piezaId]);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).resolves.toMatchObject({ hashPieza: x.w.hashHex });
      expect((await db.query('SELECT estado, version_estado FROM piezas WHERE id = $1', [x.w.piezaId])).rows).toEqual(before.rows);
    });
  });
});

describe('assertPublicable: the piece is not in a publishable state', () => {
  it('refuses a piece that waits for approval, with the state in the error', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      await interno(x); // esperando_aprobacion
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'PiezaNoPublicableError', estado: 'esperando_aprobacion' }));
    });
  });

  it("refuses another client's piece as not found", async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      const other = await world(db);
      await expect(assertPublicable(x.deps, other.clienteId, x.w.piezaId)).rejects.toThrow('not found');
    });
  });
});

describe('the central rule: one test per way to break it', () => {
  it('no approvals at all', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      await forzarAprobada(x, ['esperando_aprobacion', 'aprobada']);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'SinAprobacionVigenteError', estadoAprobacion: 'pendiente_interno' }));
    });
  });

  it('only the internal approval', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      await interno(x);
      await forzarAprobada(x, ['aprobada']);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'SinAprobacionVigenteError', estadoAprobacion: 'pendiente_cliente' }));
    });
  });

  it('only the client approval, inserted bypassing the service (and the insert trigger)', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      await forzarAprobada(x, ['esperando_aprobacion']);
      await db.query('ALTER TABLE aprobaciones DISABLE TRIGGER aprobaciones_before_insert');
      await createAprobacion(db, { piezaId: x.w.piezaId, nivel: 'cliente', usuarioId: x.actores.ids.cliente });
      await db.query('ALTER TABLE aprobaciones ENABLE TRIGGER aprobaciones_before_insert');
      await forzarAprobada(x, ['aprobada']);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'SinAprobacionVigenteError', estadoAprobacion: 'pendiente_interno' }));
    });
  });

  it('a new production version after both approvals', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      await reabrirPieza({ db }, x.clienteId, x.w.piezaId, x.actores.novaciel, 'cambio despues de aprobar');
      await moverPieza(db, x.w.piezaId, 'en_produccion');
      await createProduccion(db, { piezaId: x.w.piezaId });
      await forzarAprobada(x, ['en_control_calidad', 'revision_novaciel', 'esperando_aprobacion', 'aprobada']);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'SinAprobacionVigenteError', estadoAprobacion: 'pendiente_interno' }));
    });
  });

  describe('the stored production row is changed (the immutability trigger is disabled inside the test transaction only)', () => {
    const CAMBIOS: [string, string, unknown[]][] = [
      ['caption', 'texto_publicacion = $2', ['Otro texto de publicación']],
      ['hashtags', 'hashtags = $2', [['#otro']]],
      ['alt text', 'textos_alternativos = $2', [['Otro alt 1', 'Otro alt 2']]],
      ['location', 'ubicacion = $2', ['Otro lugar']],
      ['network', 'red = $2', ['facebook']],
    ];
    it.each(CAMBIOS)('%s', async (_name, set, params) => {
      await withTestTransaction(async (db) => {
        const x = await aprobada(db);
        await sinInmutabilidad(db);
        await db.query(`UPDATE producciones SET ${set} WHERE id = $1`, [x.w.produccionId, ...params]);
        await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'HashPiezaNoCoincideError', contra: 'almacenado' }));
      });
    });
  });

  it('one byte of a stored file changed in storage', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      const changed = Buffer.from(x.w.cuerpos[1]!);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 0x01;
      await x.storage.put(x.w.claves[1]!, changed, 'image/jpeg');
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'ArchivoAlteradoError', orden: 2, motivo: 'sha256' }));
    });
  });

  it('two files swapped in storage', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      // Same length, different content: the swap is caught by the SHA-256, not by the size.
      expect(x.w.cuerpos[0]!.length).toBe(x.w.cuerpos[1]!.length);
      await x.storage.put(x.w.claves[0]!, x.w.cuerpos[1]!, 'image/jpeg');
      await x.storage.put(x.w.claves[1]!, x.w.cuerpos[0]!, 'image/jpeg');
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'ArchivoAlteradoError', orden: 1, motivo: 'sha256' }));
    });
  });

  it('a stored file that is missing, or whose size changed', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      await x.storage.put(x.w.claves[0]!, Buffer.concat([x.w.cuerpos[0]!, Buffer.from('x')]), 'image/jpeg');
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'ArchivoAlteradoError', orden: 1, motivo: 'tamano' }));
      await x.storage.delete(x.w.claves[0]!);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ name: 'ArchivoAlteradoError', orden: 1, motivo: 'ausente' }));
    });
  });

  it('a fact expired after the approval (rule 2 at publish time)', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      await db.query(`UPDATE hechos_verificados SET vigente_hasta = now() - interval '1 hour' WHERE id = $1`, [x.w.hechoId]);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toBeInstanceOf(ProduccionHechoVencidoError);
    });
  });

  it('a media authorization revoked after the approval', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      await db.query(`UPDATE autorizaciones_imagen SET revocada_en = now() WHERE id = $1`, [x.w.autorizacionIds[0]]);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toBeInstanceOf(ProduccionMediaNoUsableError);
    });
  });

  it('a client approval recorded by a NovaCiel user is refused at insert, so the piece never becomes approved', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      await interno(x);
      await expect(
        registrarDecision({ db }, x.clienteId, x.w.piezaId, x.actores.novaciel, { nivel: 'cliente', decision: 'aprobada', hashVisto: x.w.hashHex }),
      ).rejects.toBeInstanceOf(PermisoDenegadoError);
      // Even straight into the database, with a NovaCiel user and a client role the staff does not hold.
      const staff = await createUsuarioConRol(db, 'operador_novaciel');
      await db.query('SAVEPOINT bypass');
      await expect(createAprobacion(db, { piezaId: x.w.piezaId, nivel: 'cliente', usuarioId: staff.id, rolCodigo: 'aprobador_cliente' })).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT bypass');
      await forzarAprobada(x, ['aprobada']);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toBeInstanceOf(SinAprobacionVigenteError);
    });
  });

  it('an approval with a stale hashVisto is refused, and the piece stays unpublishable', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      await interno(x);
      await expect(cliente(x, 'a'.repeat(64))).rejects.toBeInstanceOf(HashDesactualizadoError);
      await forzarAprobada(x, ['aprobada']);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toEqual(expect.objectContaining({ estadoAprobacion: 'pendiente_cliente' }));
    });
  });
});

describe('assertPublicable cleans up after itself', () => {
  const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith('novaciel-publicable-'));

  it('removes its temporary folder on success and on every kind of failure', async () => {
    await withTestTransaction(async (db) => {
      const before = leftovers();
      const x = await aprobada(db);
      await assertPublicable(x.deps, x.clienteId, x.w.piezaId);
      expect(leftovers()).toEqual(before);

      // Failure after downloading one file and before the second (sha256 differs).
      await x.storage.put(x.w.claves[1]!, Buffer.from('x'.repeat(x.w.cuerpos[1]!.length)), 'image/jpeg');
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toBeInstanceOf(ArchivoAlteradoError);
      expect(leftovers()).toEqual(before);

      // A file that is missing from storage.
      await x.storage.delete(x.w.claves[0]!);
      await expect(assertPublicable(x.deps, x.clienteId, x.w.piezaId)).rejects.toBeInstanceOf(ArchivoAlteradoError);
      expect(leftovers()).toEqual(before);

      // A failure after the files were verified (the stored hash no longer matches the data).
      const y = await aprobada(db);
      await sinInmutabilidad(db);
      await db.query(`UPDATE producciones SET texto_publicacion = 'otro' WHERE id = $1`, [y.w.produccionId]);
      await expect(assertPublicable(y.deps, y.clienteId, y.w.piezaId)).rejects.toBeInstanceOf(HashPiezaNoCoincideError);
      expect(leftovers()).toEqual(before);
    });
  });

  it('refusals carry ids and states, never the caption', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      await sinInmutabilidad(db);
      await db.query(`UPDATE producciones SET texto_publicacion = 'Texto secreto del cliente' WHERE id = $1`, [x.w.produccionId]);
      const error = await assertPublicable(x.deps, x.clienteId, x.w.piezaId).catch((e: Error) => e);
      expect(error).toBeInstanceOf(HashPiezaNoCoincideError);
      expect(JSON.stringify({ message: (error as Error).message, ...(error as object) })).not.toContain('secreto');
    });
  });
});

describe('assertPublicable: PiezaNoPublicableError', () => {
  it('is a typed error with the state and the plan state', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      const error = await assertPublicable(x.deps, x.clienteId, x.w.piezaId).catch((e: Error) => e);
      expect(error).toBeInstanceOf(PiezaNoPublicableError);
      expect(error).toMatchObject({ estado: 'revision_novaciel', planEstado: 'aprobado' });
    });
  });
});
