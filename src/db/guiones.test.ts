import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  createCliente,
  createGuion,
  createGuionHecho,
  createHechoVerificado,
  createMedia,
  createPerfilMarca,
  createPieza,
  createPlanSemanal,
  createToma,
  createUsuario,
  guionContenido,
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

/** Raw insert, to try combinations the factory would not build. */
async function insertGuion(db: Db, p: { clienteId: string; piezaId: string; perfilMarcaId: string; version?: number; formato?: string; esActual?: boolean; contenido?: unknown }) {
  const contenido = JSON.stringify(p.contenido === undefined ? guionContenido() : p.contenido);
  return db.query(
    `INSERT INTO guiones (cliente_id, pieza_id, version, es_actual, perfil_marca_id, formato, contenido_modelo, contenido)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
    [p.clienteId, p.piezaId, p.version ?? 1, p.esActual ?? true, p.perfilMarcaId, p.formato ?? 'carrusel', contenido],
  );
}

/** An approved plan with a piece waiting for its brief, and the profile version of the client. */
async function waitingPiece(db: Db, clienteId?: string, formato = 'carrusel') {
  const cliente = clienteId ? { id: clienteId } : await createCliente(db);
  const perfil = await createPerfilMarca(db, { clienteId: cliente.id });
  const plan = await createPlanSemanal(db, { clienteId: cliente.id, estado: 'aprobado', perfilMarcaId: perfil.id });
  const pieza = await createPieza(db, { clienteId: cliente.id, planId: plan.id, estado: 'plan_aprobado', formato });
  return { clienteId: cliente.id, perfil, plan, pieza };
}

describe('guiones: who may point at what', () => {
  it('stores a brief with its slots and fact links for a piece of an approved plan', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      const media = await createMedia(db, { clienteId: w.clienteId });
      const hecho = await createHechoVerificado(db, { clienteId: w.clienteId });
      const guion = await createGuion(db, {
        piezaId: w.pieza.id,
        tomas: [{ mediaId: media.id, entradaMs: 0, salidaMs: 0 + 1 }, { motivoFaltante: 'No hay foto del producto' }],
        hechoIds: [hecho.id],
      });
      expect(guion).toMatchObject({ version: 1, es_actual: true, cliente_id: w.clienteId, formato: 'carrusel' });
      const tomas = (await db.query('SELECT orden, fuente, media_id FROM tomas WHERE guion_id = $1 ORDER BY orden', [guion.id])).rows;
      expect(tomas).toEqual([
        { orden: 1, fuente: 'media_real', media_id: media.id },
        { orden: 2, fuente: 'faltante', media_id: null },
      ]);
    });
  });

  it("cannot point to another client's piece, profile version, media or fact", async () => {
    await withTestTransaction(async (db) => {
      const a = await waitingPiece(db);
      const b = await waitingPiece(db);
      const mediaB = await createMedia(db, { clienteId: b.clienteId });
      const hechoB = await createHechoVerificado(db, { clienteId: b.clienteId });

      // Piece of B under client A (the insert trigger answers first; the composite FK is the second layer).
      await expectFails(db, /piece does not exist for this client/, () => insertGuion(db, { clienteId: a.clienteId, piezaId: b.pieza.id, perfilMarcaId: a.perfil.id }));
      // Profile version of B under client A.
      await expectFails(db, FK_VIOLATION, () => insertGuion(db, { clienteId: a.clienteId, piezaId: a.pieza.id, perfilMarcaId: b.perfil.id }));

      const guionA = await createGuion(db, { piezaId: a.pieza.id });
      await expectFails(db, FK_VIOLATION, () => createToma(db, { guionId: guionA.id, clienteId: a.clienteId, orden: 1, mediaId: mediaB.id }));
      await expectFails(db, FK_VIOLATION, () => createGuionHecho(db, { guionId: guionA.id, hechoId: hechoB.id, clienteId: a.clienteId }));
      // And B's own client id on A's brief does not work either.
      await expectFails(db, FK_VIOLATION, () => createGuionHecho(db, { guionId: guionA.id, hechoId: hechoB.id, clienteId: b.clienteId }));
      await expectFails(db, FK_VIOLATION, () => createToma(db, { guionId: guionA.id, clienteId: b.clienteId, orden: 1, motivoFaltante: 'x' }));
    });
  });

  it('restricts deleting what a brief uses', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      const media = await createMedia(db, { clienteId: w.clienteId });
      const hecho = await createHechoVerificado(db, { clienteId: w.clienteId });
      await createGuion(db, { piezaId: w.pieza.id, tomas: [{ mediaId: media.id }], hechoIds: [hecho.id] });
      await expectFails(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM media WHERE id = $1', [media.id]));
      await expectFails(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM hechos_verificados WHERE id = $1', [hecho.id]));
      await expectFails(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM piezas WHERE id = $1', [w.pieza.id]));
    });
  });
});

describe('guiones: versions', () => {
  it('has only one current brief per piece', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      await createGuion(db, { piezaId: w.pieza.id });
      // A second current row is refused even with the right next version.
      await expectFails(db, UNIQUE_VIOLATION, () => insertGuion(db, { clienteId: w.clienteId, piezaId: w.pieza.id, perfilMarcaId: w.perfil.id, version: 2 }));
    });
  });

  it('requires the next version number and a current brief at birth', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      const base = { clienteId: w.clienteId, piezaId: w.pieza.id, perfilMarcaId: w.perfil.id };
      await expectFails(db, /next version of this piece is 1/, () => insertGuion(db, { ...base, version: 2 }));
      await expectFails(db, /born current/, () => insertGuion(db, { ...base, esActual: false }));
      await createGuion(db, { piezaId: w.pieza.id });
      await db.query('UPDATE guiones SET es_actual = false WHERE pieza_id = $1', [w.pieza.id]);
      await expectFails(db, /next version of this piece is 2/, () => insertGuion(db, { ...base, version: 1 }));
      await expectFails(db, /next version of this piece is 2/, () => insertGuion(db, { ...base, version: 3 }));
    });
  });

  it('keeps the old version readable, with its slots and facts, when a new one is made', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      const media = await createMedia(db, { clienteId: w.clienteId });
      const hecho = await createHechoVerificado(db, { clienteId: w.clienteId });
      const v1 = await createGuion(db, { piezaId: w.pieza.id, tomas: [{ mediaId: media.id }], hechoIds: [hecho.id], contenido: guionContenido('primera') });
      const v2 = await createGuion(db, { piezaId: w.pieza.id, tomas: [{ motivoFaltante: 'sin foto' }], contenido: guionContenido('segunda') });

      expect(v2.version).toBe(2);
      const rows = (await db.query('SELECT id, version, es_actual, contenido FROM guiones WHERE pieza_id = $1 ORDER BY version', [w.pieza.id])).rows;
      expect(rows.map((r) => [r.version, r.es_actual])).toEqual([[1, false], [2, true]]);
      expect(rows[0].contenido.gancho).toBe('primera');
      expect(rows[1].contenido.gancho).toBe('segunda');
      expect((await db.query('SELECT media_id FROM tomas WHERE guion_id = $1', [v1.id])).rows).toEqual([{ media_id: media.id }]);
      expect((await db.query('SELECT hecho_id FROM guiones_hechos WHERE guion_id = $1', [v1.id])).rows).toEqual([{ hecho_id: hecho.id }]);
    });
  });
});

describe('guiones: never edited', () => {
  it('allows only es_actual true -> false; every other change, the way back and deleting are refused', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      const guion = await createGuion(db, { piezaId: w.pieza.id });
      const perfil2 = await createPerfilMarca(db, { clienteId: w.clienteId, esActual: false });
      const otroUsuario = await createUsuario(db);

      for (const [column, value] of [
        ['version', 5],
        ['contenido', JSON.stringify({ gancho: 'otro' })],
        ['contenido_modelo', JSON.stringify({ gancho: 'otro' })],
        ['formato', 'reel'],
        ['perfil_marca_id', perfil2.id],
        ['creado_por', otroUsuario.id],
        ['creado_en', new Date(0)],
      ] as const) {
        const cast = column.startsWith('contenido') ? '::jsonb' : '';
        await expectFails(db, /a brief is never edited/, () =>
          db.query(`UPDATE guiones SET ${column} = $2${cast} WHERE id = $1`, [guion.id, value]),
        );
      }
      await expectFails(db, /cannot be deleted/, () => db.query('DELETE FROM guiones WHERE id = $1', [guion.id]));

      // The one allowed change.
      await db.query('UPDATE guiones SET es_actual = false WHERE id = $1', [guion.id]);
      // And no way back.
      await expectFails(db, /cannot become current again/, () => db.query('UPDATE guiones SET es_actual = true WHERE id = $1', [guion.id]));
      expect((await db.query('SELECT es_actual FROM guiones WHERE id = $1', [guion.id])).rows[0].es_actual).toBe(false);
    });
  });

  it('keeps the slots and fact links fixed too', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      const hecho = await createHechoVerificado(db, { clienteId: w.clienteId });
      const guion = await createGuion(db, { piezaId: w.pieza.id, tomas: [{ motivoFaltante: 'sin foto' }], hechoIds: [hecho.id] });
      await expectFails(db, /links of a brief are never changed/, () => db.query("UPDATE tomas SET motivo_faltante = 'otro' WHERE guion_id = $1", [guion.id]));
      await expectFails(db, /links of a brief are never changed/, () => db.query('DELETE FROM tomas WHERE guion_id = $1', [guion.id]));
      await expectFails(db, /links of a brief are never changed/, () => db.query('DELETE FROM guiones_hechos WHERE guion_id = $1', [guion.id]));
    });
  });
});

describe('guiones: where a brief can be born', () => {
  it('is refused when the piece is not waiting for it', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const perfil = await createPerfilMarca(db, { clienteId: cliente.id });
      const plan = await createPlanSemanal(db, { clienteId: cliente.id, estado: 'aprobado', perfilMarcaId: perfil.id });
      const planeada = await createPieza(db, { clienteId: cliente.id, planId: plan.id });
      const enProduccion = await createPieza(db, { clienteId: cliente.id, planId: plan.id, estado: 'en_produccion' });
      for (const pieza of [planeada, enProduccion]) {
        await expectFails(db, /needs the piece in plan_aprobado or guion_listo/, () =>
          insertGuion(db, { clienteId: cliente.id, piezaId: pieza.id, perfilMarcaId: perfil.id }),
        );
      }
    });
  });

  it('is refused when the plan is not approved, or is discarded', async () => {
    await withTestTransaction(async (db) => {
      for (const estado of ['borrador', 'propuesto', 'descartado'] as const) {
        const w = await waitingPiece(db);
        // The piece reached plan_aprobado while the plan was approved; now the plan moves away from it.
        await db.query('UPDATE planes_semanales SET estado = $2 WHERE id = $1', [w.plan.id, estado]);
        await expectFails(db, /plan of the piece is not approved/, () =>
          insertGuion(db, { clienteId: w.clienteId, piezaId: w.pieza.id, perfilMarcaId: w.perfil.id }),
        );
      }
    });
  });

  it('is refused for a paused piece and for a format that is not the piece format', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      await expectFails(db, /must be the piece format/, () =>
        insertGuion(db, { clienteId: w.clienteId, piezaId: w.pieza.id, perfilMarcaId: w.perfil.id, formato: 'reel' }),
      );
      await moverPieza(db, w.pieza.id, 'pausada');
      await expectFails(db, /needs the piece in plan_aprobado or guion_listo/, () =>
        insertGuion(db, { clienteId: w.clienteId, piezaId: w.pieza.id, perfilMarcaId: w.perfil.id }),
      );
    });
  });

  it('accepts a regeneration while the piece is in guion_listo, and refuses it once production started', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      await createGuion(db, { piezaId: w.pieza.id });
      await moverPieza(db, w.pieza.id, 'guion_listo');
      const v2 = await createGuion(db, { piezaId: w.pieza.id });
      expect(v2.version).toBe(2);
      await moverPieza(db, w.pieza.id, 'en_produccion');
      await db.query('UPDATE guiones SET es_actual = false WHERE pieza_id = $1', [w.pieza.id]);
      await expectFails(db, /needs the piece in plan_aprobado or guion_listo/, () =>
        insertGuion(db, { clienteId: w.clienteId, piezaId: w.pieza.id, perfilMarcaId: w.perfil.id, version: 3 }),
      );
    });
  });

  it('refuses a piece that does not exist', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      await expectFails(db, /piece does not exist for this client/, () => insertGuion(db, { clienteId: w.clienteId, piezaId: randomUUID(), perfilMarcaId: w.perfil.id }));
    });
  });
});

describe('guiones: content and slots', () => {
  it('never keeps a fact token in the rendered content, but may in the model content', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      const token = { gancho: `Hoy {{hecho:${randomUUID()}}}` };
      await expectFails(db, CHECK_VIOLATION, () => insertGuion(db, { clienteId: w.clienteId, piezaId: w.pieza.id, perfilMarcaId: w.perfil.id, contenido: token }));
      const ok = await createGuion(db, { piezaId: w.pieza.id, contenidoModelo: token, contenido: { gancho: 'Hoy cuesta 10' } });
      expect(ok.contenido_modelo).toEqual(token);
    });
  });

  it('requires both contents to be JSON objects', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      for (const contenido of [[], 'texto', 3, null]) {
        await expectFails(db, CHECK_VIOLATION, () =>
          insertGuion(db, { clienteId: w.clienteId, piezaId: w.pieza.id, perfilMarcaId: w.perfil.id, contenido }),
        );
      }
    });
  });

  it('keeps a slot coherent: real media or a reason, marks only for real media, out after in, one per position', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      const media = await createMedia(db, { clienteId: w.clienteId, tipo: 'video' });
      const guion = await createGuion(db, { piezaId: w.pieza.id });
      const base = { guionId: guion.id, clienteId: w.clienteId };

      await expectFails(db, CHECK_VIOLATION, () => createToma(db, { ...base, orden: 1, fuente: 'media_real', mediaId: null, motivoFaltante: null }));
      await expectFails(db, CHECK_VIOLATION, () => createToma(db, { ...base, orden: 1, fuente: 'faltante', mediaId: media.id, motivoFaltante: 'x' }));
      await expectFails(db, CHECK_VIOLATION, () => createToma(db, { ...base, orden: 1, mediaId: media.id, motivoFaltante: 'sobra' }));
      await expectFails(db, CHECK_VIOLATION, () => createToma(db, { ...base, orden: 1, motivoFaltante: '   ' }));
      await expectFails(db, CHECK_VIOLATION, () => createToma(db, { ...base, orden: 1, motivoFaltante: 'x', entradaMs: 0, salidaMs: 1000 }));
      await expectFails(db, CHECK_VIOLATION, () => createToma(db, { ...base, orden: 1, mediaId: media.id, entradaMs: 500, salidaMs: 500 }));
      await expectFails(db, CHECK_VIOLATION, () => createToma(db, { ...base, orden: 1, mediaId: media.id, entradaMs: 500 }));
      await expectFails(db, CHECK_VIOLATION, () => createToma(db, { ...base, orden: 0, mediaId: media.id }));

      await createToma(db, { ...base, orden: 1, mediaId: media.id, entradaMs: 0, salidaMs: 1500 });
      await expectFails(db, UNIQUE_VIOLATION, () => createToma(db, { ...base, orden: 1, motivoFaltante: 'otra' }));
    });
  });

  it('accepts one fact once per brief', async () => {
    await withTestTransaction(async (db) => {
      const w = await waitingPiece(db);
      const hecho = await createHechoVerificado(db, { clienteId: w.clienteId });
      const guion = await createGuion(db, { piezaId: w.pieza.id, hechoIds: [hecho.id] });
      await expectFails(db, UNIQUE_VIOLATION, () => createGuionHecho(db, { guionId: guion.id, hechoId: hecho.id, clienteId: w.clienteId }));
    });
  });
});
