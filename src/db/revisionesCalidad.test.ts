import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  checkQC,
  createAprobableWorld,
  createAprobacion,
  createCliente,
  createPieza,
  createPlanSemanal,
  createProduccion,
  createRevisionCalidad,
  createUsuarioConRol,
  insertHistorial,
  moverPieza,
} from '../../tests/utils/factories/index.js';
import type { Db } from './types.js';

// Step 8, checkpoint A: the QC report table. Plain-SQL factories, so everything here goes through the
// database triggers, which are what the table is about.

/** Expects `run` to fail with a message matching `match`, keeping the surrounding transaction usable. */
async function expectFails(db: Db, match: string | RegExp, run: () => Promise<unknown>): Promise<void> {
  await db.query('SAVEPOINT expect_fails');
  await expect(run()).rejects.toThrow(match);
  await db.query('ROLLBACK TO SAVEPOINT expect_fails');
}

/** A piece in en_control_calidad with its production, the only state a report can be recorded in. */
const enControl = (db: Db, o: { clienteId?: string; semanaInicio?: string } = {}) => createAprobableWorld(db, { estado: 'en_control_calidad', ...o });

describe('revisiones_calidad: append-only', () => {
  it('refuses UPDATE, DELETE and TRUNCATE, also outside the test cleanup flag', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      const r = await createRevisionCalidad(db, { piezaId: w.piezaId });
      await expectFails(db, /append-only/, () => db.query("UPDATE revisiones_calidad SET resultado = 'rechazado' WHERE id = $1", [r.id]));
      await expectFails(db, /append-only/, () => db.query('UPDATE revisiones_calidad SET duracion_ms = 1 WHERE id = $1', [r.id]));
      await expectFails(db, /append-only/, () => db.query('DELETE FROM revisiones_calidad WHERE id = $1', [r.id]));
      await expectFails(db, /append-only/, () => db.query('TRUNCATE revisiones_calidad'));
      expect((await db.query('SELECT 1 FROM revisiones_calidad WHERE id = $1', [r.id])).rows).toHaveLength(1);
    });
  });

  it('keeps every run: the table grows, one row per QC run, and the order is the sequence', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      const first = await createRevisionCalidad(db, { piezaId: w.piezaId, checks: [checkQC('archivo_hash_distinto', 'no_pasa')] });
      const second = await createRevisionCalidad(db, { piezaId: w.piezaId });
      expect(first.resultado).toBe('rechazado');
      expect(second.resultado).toBe('aprobado');
      expect(BigInt(second.seq)).toBeGreaterThan(BigInt(first.seq));
    });
  });
});

describe('revisiones_calidad: the report binds to the exact current production', () => {
  it('records a report of the current production, with its version and hash', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      const r = await createRevisionCalidad(db, { piezaId: w.piezaId, duracionMs: 321 });
      expect(r).toMatchObject({ pieza_id: w.piezaId, produccion_id: w.produccionId, produccion_version: 1, hash_version: 'np1', resultado: 'aprobado', duracion_ms: 321, actor_tipo: 'sistema' });
      expect(r.hash_pieza).toHaveLength(32);
    });
  });

  it('refuses another hash, another version or another hash version', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      await expectFails(db, /does not match the current production/, () => createRevisionCalidad(db, { piezaId: w.piezaId, hashPieza: randomBytes(32) }));
      await expectFails(db, /does not match the current production/, () => createRevisionCalidad(db, { piezaId: w.piezaId, produccionVersion: 2 }));
      await expectFails(db, /does not match the current production|check/i, () => createRevisionCalidad(db, { piezaId: w.piezaId, hashVersion: 'np2' }));
    });
  });

  it('refuses a production that is no longer the current one (a new version voids the old target)', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      const old = (await db.query<{ version: number; hash_pieza: Buffer }>('SELECT version, hash_pieza FROM producciones WHERE id = $1', [w.produccionId])).rows[0]!;
      await createProduccion(db, { piezaId: w.piezaId });
      await expectFails(db, /only the current production/, () =>
        createRevisionCalidad(db, { piezaId: w.piezaId, produccionId: w.produccionId, produccionVersion: old.version, hashPieza: old.hash_pieza }),
      );
      // The new current production gets its report.
      await expect(createRevisionCalidad(db, { piezaId: w.piezaId })).resolves.toMatchObject({ produccion_version: 2 });
    });
  });

  it('refuses a production of another piece or of another client', async () => {
    await withTestTransaction(async (db) => {
      const a = await enControl(db);
      const sameClient = await enControl(db, { clienteId: a.clienteId, semanaInicio: '2027-01-04' });
      const b = await enControl(db);
      await expectFails(db, /belongs to another piece/, () => createRevisionCalidad(db, { piezaId: a.piezaId, produccionId: sameClient.produccionId }));
      await expectFails(db, /does not exist for this client|violates foreign key/, () => createRevisionCalidad(db, { piezaId: a.piezaId, produccionId: b.produccionId }));
    });
  });

  it('refuses a piece that is not in en_control_calidad', async () => {
    await withTestTransaction(async (db) => {
      for (const estado of ['revision_novaciel', 'esperando_aprobacion', 'aprobada'] as const) {
        const w = await createAprobableWorld(db, { estado });
        await expectFails(db, new RegExp(`a piece in ${estado} cannot get a quality report`), () => createRevisionCalidad(db, { piezaId: w.piezaId }));
      }
    });
  });
});

describe('revisiones_calidad: the result is the verdict of the checks', () => {
  it('refuses an approved report with a failed check, and a rejected one with none', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      const failed = [checkQC('regla_prohibida_palabra', 'no_pasa'), checkQC('hashtags_cantidad')];
      await expectFails(db, /approved report cannot contain failed checks/, () => createRevisionCalidad(db, { piezaId: w.piezaId, resultado: 'aprobado', checks: failed }));
      await expectFails(db, /rejected report needs at least one failed check/, () => createRevisionCalidad(db, { piezaId: w.piezaId, resultado: 'rechazado', checks: [checkQC('hashtags_cantidad')] }));
      // A warning does not reject.
      await expect(
        createRevisionCalidad(db, { piezaId: w.piezaId, checks: [checkQC('programacion_proxima', 'advertencia'), checkQC('hashtags_cantidad')] }),
      ).resolves.toMatchObject({ resultado: 'aprobado', codigos_fallo: [] });
      await expect(createRevisionCalidad(db, { piezaId: w.piezaId, checks: failed })).resolves.toMatchObject({
        resultado: 'rechazado',
        codigos_fallo: ['regla_prohibida_palabra'],
      });
    });
  });

  it('refuses failure codes that do not match the failed checks', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      const checks = [checkQC('regla_prohibida_palabra', 'no_pasa')];
      await expectFails(db, /codigos_fallo does not match/, () => createRevisionCalidad(db, { piezaId: w.piezaId, checks, codigosFallo: [] }));
      await expectFails(db, /codigos_fallo does not match/, () => createRevisionCalidad(db, { piezaId: w.piezaId, checks, codigosFallo: ['otro_codigo'] }));
    });
  });

  it('refuses malformed checks: no checks, a bad code, an unknown result, a missing reason or parameters', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      await expectFails(db, /check/i, () => createRevisionCalidad(db, { piezaId: w.piezaId, checks: [] }));
      const bad = (patch: Record<string, unknown>) => [{ ...checkQC('hashtags_cantidad'), ...patch }] as never;
      await expectFails(db, /every check needs/, () => createRevisionCalidad(db, { piezaId: w.piezaId, checks: bad({ codigo: 'Codigo Con Espacios' }) }));
      await expectFails(db, /every check needs/, () => createRevisionCalidad(db, { piezaId: w.piezaId, checks: bad({ resultado: 'quizas' }) }));
      await expectFails(db, /every check needs/, () => createRevisionCalidad(db, { piezaId: w.piezaId, checks: bad({ severidad: 'grave' }) }));
      await expectFails(db, /every check needs/, () => createRevisionCalidad(db, { piezaId: w.piezaId, checks: bad({ motivo: undefined }) }));
      await expectFails(db, /every check needs/, () => createRevisionCalidad(db, { piezaId: w.piezaId, checks: bad({ parametros: 'texto' }) }));
    });
  });

  it('records the user who ran it, or the system', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      const staff = await createUsuarioConRol(db, 'operador_novaciel');
      await expect(createRevisionCalidad(db, { piezaId: w.piezaId, actorUsuarioId: staff.id })).resolves.toMatchObject({ actor_tipo: 'usuario', actor_usuario_id: staff.id });
      await expect(createRevisionCalidad(db, { piezaId: w.piezaId })).resolves.toMatchObject({ actor_tipo: 'sistema', actor_usuario_id: null });
    });
  });
});

describe('the Step 8 bridge is removed at the database level', () => {
  it('refuses an internal decision from en_control_calidad and accepts it from revision_novaciel', async () => {
    await withTestTransaction(async (db) => {
      const early = await enControl(db);
      for (const decision of ['aprobada', 'cambios'] as const) {
        await expectFails(db, /a piece in en_control_calidad cannot get an internal decision/, () =>
          createAprobacion(db, { piezaId: early.piezaId, nivel: 'interno', decision }),
        );
      }
      const reviewed = await createAprobableWorld(db, { estado: 'revision_novaciel' });
      await expect(createAprobacion(db, { piezaId: reviewed.piezaId, nivel: 'interno' })).resolves.toMatchObject({ nivel: 'interno', decision: 'aprobada' });
    });
  });
});

describe('revision_novaciel -> con_cambios (NovaCiel only)', () => {
  const versionOf = async (db: Db, piezaId: string) => (await db.query<{ v: number }>('SELECT version_estado AS v FROM piezas WHERE id = $1', [piezaId])).rows[0]!.v;

  it('NovaCiel and the system can send a piece in review back, and it can be produced again', async () => {
    await withTestTransaction(async (db) => {
      const staff = await createUsuarioConRol(db, 'operador_novaciel');
      const byStaff = await createAprobableWorld(db, { estado: 'revision_novaciel' });
      await moverPieza(db, byStaff.piezaId, 'con_cambios', { actor: { tipo: 'usuario', usuarioId: staff.id }, motivo: 'cambios_internos' });
      const bySystem = await createAprobableWorld(db, { estado: 'revision_novaciel' });
      await moverPieza(db, bySystem.piezaId, 'con_cambios', { actor: { tipo: 'sistema' } });
      const { rows } = await db.query('SELECT estado FROM piezas WHERE id = ANY($1)', [[byStaff.piezaId, bySystem.piezaId]]);
      expect(rows.map((r) => r.estado)).toEqual(['con_cambios', 'con_cambios']);

      // The next production version is allowed from con_cambios, and QC can report on it.
      await createProduccion(db, { piezaId: byStaff.piezaId });
      await moverPieza(db, byStaff.piezaId, 'en_produccion');
      await moverPieza(db, byStaff.piezaId, 'en_control_calidad');
      await expect(createRevisionCalidad(db, { piezaId: byStaff.piezaId })).resolves.toMatchObject({ produccion_version: 2 });
    });
  });

  it('a client user (approver, owner or collaborator) cannot do it, even if the service had a bug', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db, { estado: 'revision_novaciel' });
      for (const rolCodigo of ['aprobador_cliente', 'dueno_cliente', 'colaborador_cliente']) {
        const client = await createUsuarioConRol(db, rolCodigo, w.clienteId);
        const version = await versionOf(db, w.piezaId);
        await expectFails(db, /only NovaCiel can move/, () =>
          insertHistorial(db, w.piezaId, w.clienteId, { version: version + 1, desde: 'revision_novaciel', hacia: 'con_cambios', actor: { tipo: 'usuario', usuarioId: client.id } }),
        );
      }
    });
  });

  it('is the only new edge: en_control_calidad still cannot go straight to con_cambios', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      const version = await versionOf(db, w.piezaId);
      await expectFails(db, /not an allowed transition/, () =>
        insertHistorial(db, w.piezaId, w.clienteId, { version: version + 1, desde: 'en_control_calidad', hacia: 'con_cambios', actor: { tipo: 'sistema' } }),
      );
    });
  });
});

describe('revisiones_calidad: every row has a client', () => {
  it('refuses a report without cliente_id or with a client that does not own the piece', async () => {
    await withTestTransaction(async (db) => {
      const w = await enControl(db);
      const other = await createCliente(db);
      const plan = await createPlanSemanal(db, { clienteId: other.id, estado: 'aprobado' });
      const foreignPiece = await createPieza(db, { clienteId: other.id, planId: plan.id });
      await expectFails(db, /null value|not-null|does not exist for this client/i, () =>
        db.query(
          `INSERT INTO revisiones_calidad (pieza_id, produccion_id, produccion_version, hash_version, hash_pieza, resultado, checks, duracion_ms, actor_tipo)
           VALUES ($1, $2, 1, 'np1', $3, 'aprobado', $4::jsonb, 1, 'sistema')`,
          [w.piezaId, w.produccionId, randomBytes(32), JSON.stringify([checkQC('hashtags_cantidad')])],
        ),
      );
      await expectFails(db, /violates foreign key|does not exist|belongs to another piece/, () =>
        db.query(
          `INSERT INTO revisiones_calidad (cliente_id, pieza_id, produccion_id, produccion_version, hash_version, hash_pieza, resultado, checks, duracion_ms, actor_tipo)
           VALUES ($1, $2, $3, 1, 'np1', $4, 'aprobado', $5::jsonb, 1, 'sistema')`,
          [w.clienteId, foreignPiece.id, w.produccionId, randomBytes(32), JSON.stringify([checkQC('hashtags_cantidad')])],
        ),
      );
    });
  });
});
