import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { getTestPool } from '../../tests/utils/testPool.js';
import {
  checkQC,
  createActores,
  createAprobacion,
  createPiezaAprobable,
  createProduccion,
  createRevisionCalidad,
  insertHistorial,
  moverPieza,
  type Actores,
  type PiezaAprobable,
} from '../../tests/utils/factories/index.js';
import { FakeStorage } from '../lib/media/storage/fakeStorage.js';
import { asClienteId } from '../modules/shared/clienteId.js';
import { registrarDecision } from '../modules/aprobaciones/aprobacionesService.js';
import type { Db } from './types.js';

// The database guard historial_estados_pieza_aprobacion (migration 1800): no piece enters `aprobada` or
// `programada` unless the records approve its CURRENT production (id, version, hash_version, hash_pieza).
// These tests never turn the test-only switch on for the move under test.

async function expectFails(db: Db, match: string | RegExp, run: () => Promise<unknown>): Promise<void> {
  await db.query('SAVEPOINT expect_fails');
  await expect(run()).rejects.toThrow(match);
  await db.query('ROLLBACK TO SAVEPOINT expect_fails');
}

/** A plain history row for the piece, without the factory's switch: the guard sees it. */
async function mover(db: Db, w: PiezaAprobable, hacia: string) {
  const { rows } = await db.query<{ estado: string; version_estado: number }>('SELECT estado, version_estado FROM piezas WHERE id = $1', [w.piezaId]);
  const pieza = rows[0]!;
  await db.query(
    `INSERT INTO historial_estados_pieza (cliente_id, pieza_id, version, desde, hacia, actor_tipo) VALUES ($1, $2, $3, $4, $5, 'sistema')`,
    [w.clienteId, w.piezaId, pieza.version_estado + 1, pieza.estado, hacia],
  );
  await db.query('UPDATE piezas SET estado = $2 WHERE id = $1', [w.piezaId, hacia]);
}

async function enEsperaDelCliente(db: Db) {
  const w = await createPiezaAprobable(db, new FakeStorage());
  const actores = await createActores(db, w.clienteId);
  const clienteId = asClienteId(w.clienteId);
  await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
  return { w, actores, clienteId };
}

describe('the approval guard on the publishable states', () => {
  it('refuses aprobada with no approvals, with only the internal one, and passes with both', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage());
      await moverPieza(db, w.piezaId, 'esperando_aprobacion');
      await expectFails(db, /no internal approval/, () => mover(db, w, 'aprobada'));
      // The records are made in the state each level decides in: the internal one before the piece moves on.
      const bare = await createPiezaAprobable(db, new FakeStorage());
      await createAprobacion(db, { piezaId: bare.piezaId, nivel: 'interno' });
      await moverPieza(db, bare.piezaId, 'esperando_aprobacion');
      await expectFails(db, /no client approval/, () => mover(db, bare, 'aprobada'));
      await createAprobacion(db, { piezaId: bare.piezaId, nivel: 'cliente' });
      await mover(db, bare, 'aprobada');
      expect((await db.query('SELECT estado FROM piezas WHERE id = $1', [bare.piezaId])).rows[0]!.estado).toBe('aprobada');
    });
  });

  it('refuses programada too, whatever the origin, and lets an approved piece be scheduled', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await enEsperaDelCliente(db);
      await registrarDecision({ db }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex });
      await mover(db, w, 'programada'); // aprobada -> programada, approvals valid
      // Resume from pause goes back through the guard as well.
      await moverPieza(db, w.piezaId, 'pausada');
      await mover(db, w, 'programada');

      const bare = await createPiezaAprobable(db, new FakeStorage());
      await moverPieza(db, bare.piezaId, 'esperando_aprobacion');
      await expectFails(db, /no internal approval/, () => mover(db, bare, 'programada'));
    });
  });

  it('refuses when the approvals are for an OLDER production of the same piece (a new version voids them)', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage());
      await createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno' });
      await moverPieza(db, w.piezaId, 'esperando_aprobacion');
      await createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente' });
      // Both levels approved version 1. Then NovaCiel produces version 2 (a new hash).
      await moverPieza(db, w.piezaId, 'con_cambios');
      await moverPieza(db, w.piezaId, 'en_produccion');
      await createProduccion(db, { piezaId: w.piezaId });
      await moverPieza(db, w.piezaId, 'en_control_calidad');
      await moverPieza(db, w.piezaId, 'revision_novaciel');
      await moverPieza(db, w.piezaId, 'esperando_aprobacion');
      await expectFails(db, /no internal approval of the current production and hash/, () => mover(db, w, 'aprobada'));
    });
  });

  it('compares the hash byte by byte: records of the current production row with another hash do not count', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage());
      await moverPieza(db, w.piezaId, 'esperando_aprobacion');
      // Forged: same production id and version, another hash (the insert trigger is disabled for the forgery).
      await db.query('ALTER TABLE aprobaciones DISABLE TRIGGER aprobaciones_before_insert');
      const forged = { piezaId: w.piezaId, produccionId: w.produccionId, version: 1, hashPieza: randomBytes(32) };
      await createAprobacion(db, { ...forged, nivel: 'interno' });
      await createAprobacion(db, { ...forged, nivel: 'cliente' });
      await db.query('ALTER TABLE aprobaciones ENABLE TRIGGER aprobaciones_before_insert');
      await expectFails(db, /no internal approval of the current production and hash/, () => mover(db, w, 'aprobada'));
      // Another hash_version is not the same hash either.
      await db.query('ALTER TABLE aprobaciones DISABLE TRIGGER aprobaciones_before_insert');
      await db.query('ALTER TABLE aprobaciones DROP CONSTRAINT aprobaciones_hash_version_check');
      const np2 = { piezaId: w.piezaId, produccionId: w.produccionId, version: 1, hashPieza: w.hashPieza, hashVersion: 'np2' };
      await createAprobacion(db, { ...np2, nivel: 'interno' });
      await createAprobacion(db, { ...np2, nivel: 'cliente' });
      await expectFails(db, /no internal approval of the current production and hash/, () => mover(db, w, 'aprobada'));
    });
  });

  it('refuses an order that is wrong (client before internal) and a change request or rejection newer than the internal approval', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage());
      await moverPieza(db, w.piezaId, 'esperando_aprobacion');
      await db.query('ALTER TABLE aprobaciones DISABLE TRIGGER aprobaciones_before_insert');
      await createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente' });
      await createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno' });
      await expectFails(db, /no client approval/, () => mover(db, w, 'aprobada'));
      await createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente' });
      await mover(db, w, 'aprobada'); // now internal < client: allowed
      await moverPieza(db, w.piezaId, 'con_cambios');
      await moverPieza(db, w.piezaId, 'en_produccion');
      await moverPieza(db, w.piezaId, 'en_control_calidad');
      await moverPieza(db, w.piezaId, 'revision_novaciel');
      await moverPieza(db, w.piezaId, 'esperando_aprobacion');
      // A change request on the current production, newer than the internal approval, voids the pair.
      await createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', decision: 'cambios', motivo: 'texto' });
      await expectFails(db, /change request or rejection is newer/, () => mover(db, w, 'aprobada'));
    });
  });

  it('refuses a piece without a current production', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage());
      await moverPieza(db, w.piezaId, 'esperando_aprobacion');
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE producciones DISABLE TRIGGER producciones_before_update_delete');
      await db.query('UPDATE producciones SET es_actual = false WHERE id = $1', [w.produccionId]);
      await expectFails(db, /no current production/, () => mover(db, w, 'aprobada'));
    });
  });

  it('does not touch the other transitions', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage());
      await mover(db, w, 'esperando_aprobacion');
      await mover(db, w, 'rechazada');
    });
  });
});

describe('the approval guard also needs a passing quality-control report', () => {
  const rechazo = [checkQC('hashtags_forma', 'no_pasa')];

  /** Both approvals recorded (through the factory), the piece waiting for the client: only the report is in question. */
  async function conAprobaciones(db: Db, w: PiezaAprobable) {
    await createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno' });
    await moverPieza(db, w.piezaId, 'esperando_aprobacion');
    await createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente' });
  }
  const estadoDe = async (db: Db, w: PiezaAprobable) => (await db.query('SELECT estado FROM piezas WHERE id = $1', [w.piezaId])).rows[0]!.estado;

  it('refuses aprobada with both approvals but no report', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage(), { sinInformeQC: true });
      await conAprobaciones(db, w);
      await expectFails(db, /no passing quality-control report/, () => mover(db, w, 'aprobada'));
      expect(await estadoDe(db, w)).toBe('esperando_aprobacion');
    });
  });

  it('refuses it through the services too: the client approval cannot move the piece without a report', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage(), { sinInformeQC: true });
      const actores = await createActores(db, w.clienteId);
      const clienteId = asClienteId(w.clienteId);
      await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex }),
      ).rejects.toThrow(/no passing quality-control report/);
    });
  });

  it('refuses a rejected report, and passes with an approved one', async () => {
    await withTestTransaction(async (db) => {
      const rechazada = await createPiezaAprobable(db, new FakeStorage(), { estado: 'en_control_calidad' });
      await createRevisionCalidad(db, { piezaId: rechazada.piezaId, checks: rechazo });
      await moverPieza(db, rechazada.piezaId, 'revision_novaciel');
      await conAprobaciones(db, rechazada);
      await expectFails(db, /no passing quality-control report/, () => mover(db, rechazada, 'aprobada'));

      const buena = await createPiezaAprobable(db, new FakeStorage());
      await conAprobaciones(db, buena);
      await mover(db, buena, 'aprobada');
      expect(await estadoDe(db, buena)).toBe('aprobada');
      await mover(db, buena, 'programada'); // the same report lets it be scheduled
      expect(await estadoDe(db, buena)).toBe('programada');
    });
  });

  it('the LATEST report of the production counts, by seq', async () => {
    await withTestTransaction(async (db) => {
      const pasaDespues = await createPiezaAprobable(db, new FakeStorage(), { estado: 'en_control_calidad' });
      await createRevisionCalidad(db, { piezaId: pasaDespues.piezaId, checks: rechazo });
      await createRevisionCalidad(db, { piezaId: pasaDespues.piezaId });
      await moverPieza(db, pasaDespues.piezaId, 'revision_novaciel');
      await conAprobaciones(db, pasaDespues);
      await mover(db, pasaDespues, 'aprobada');

      const rechazaDespues = await createPiezaAprobable(db, new FakeStorage(), { estado: 'en_control_calidad' });
      await createRevisionCalidad(db, { piezaId: rechazaDespues.piezaId });
      await createRevisionCalidad(db, { piezaId: rechazaDespues.piezaId, checks: rechazo });
      await moverPieza(db, rechazaDespues.piezaId, 'revision_novaciel');
      await conAprobaciones(db, rechazaDespues);
      await expectFails(db, /no passing quality-control report/, () => mover(db, rechazaDespues, 'aprobada'));
    });
  });

  it('a report of an OLDER production does not count, even with the approvals of the new one', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage()); // report of production 1
      await moverPieza(db, w.piezaId, 'con_cambios');
      await createProduccion(db, { piezaId: w.piezaId });
      for (const estado of ['en_produccion', 'en_control_calidad', 'revision_novaciel']) await moverPieza(db, w.piezaId, estado);
      await conAprobaciones(db, w);
      await expectFails(db, /no passing quality-control report/, () => mover(db, w, 'aprobada'));
      expect((await db.query('SELECT count(*)::int AS n FROM revisiones_calidad WHERE pieza_id = $1', [w.piezaId])).rows[0].n).toBe(1);
    });
  });

  it('keeps the approval errors first: with no internal approval it still says so', async () => {
    await withTestTransaction(async (db) => {
      const w = await createPiezaAprobable(db, new FakeStorage(), { sinInformeQC: true });
      await moverPieza(db, w.piezaId, 'esperando_aprobacion');
      await expectFails(db, /no internal approval/, () => mover(db, w, 'aprobada'));
    });
  });
});

describe('the test-only switch novaciel.omitir_guarda_aprobacion', () => {
  const SWITCH = `SELECT coalesce(current_setting('novaciel.omitir_guarda_aprobacion', true), '') AS v`;

  it('is transaction-scoped: it does not leak to a later transaction on the same pooled connection', async () => {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('novaciel.omitir_guarda_aprobacion', 'si', true)`);
      expect((await client.query(SWITCH)).rows[0].v).toBe('si');
      await client.query('COMMIT');
      // Same connection, next transaction: the switch is gone, and the guard works again.
      await client.query('BEGIN');
      expect((await client.query(SWITCH)).rows[0].v).not.toBe('si');
      const w = await createPiezaAprobable(client, new FakeStorage());
      await moverPieza(client, w.piezaId, 'esperando_aprobacion');
      await expectFails(client, /no internal approval/, () => mover(client, w, 'aprobada'));
      await client.query('ROLLBACK');

      // Even a rolled-back transaction leaves nothing behind.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('novaciel.omitir_guarda_aprobacion', 'si', true)`);
      await client.query('ROLLBACK');
      expect((await client.query(SWITCH)).rows[0].v).not.toBe('si');
    } finally {
      client.release();
    }
  });

  it('the factories put the previous value back after their own insert, so it never stays on', async () => {
    await withTestTransaction(async (db) => {
      expect((await db.query(SWITCH)).rows[0].v).not.toBe('si');
      const w = await createPiezaAprobable(db, new FakeStorage());
      expect((await db.query(SWITCH)).rows[0].v).not.toBe('si');
      await expectFails(db, /no internal approval/, () => mover(db, w, 'aprobada'));
    });
    // And when a test turns it on for the whole transaction, a factory call keeps it on (previous value restored).
    await withTestTransaction(
      async (db) => {
        const w = await createPiezaAprobable(db, new FakeStorage());
        await insertHistorial(db, w.piezaId, w.clienteId, { version: 99, desde: null, hacia: 'planeada', actor: { tipo: 'sistema' } }).catch(() => undefined);
        expect((await db.query(SWITCH)).rows[0].v).toBe('si');
      },
      { sinGuardaDeAprobacion: true },
    );
  });

  it('is honoured only because this database name ends in _test', async () => {
    await withTestTransaction(async (db) => {
      expect((await db.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name).toMatch(/_test$/);
    });
  });
});

// Type-only use to keep the helpers' types in sync with the factories.
export type { Actores };
