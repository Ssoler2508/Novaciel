import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  createCliente,
  createHechoVerificado,
  createPerfilMarca,
  createPieza,
  createPiezaHecho,
  createPlanSemanal,
  createUsuario,
  insertHistorial,
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

// The transitions of spec section 15, written out by hand HERE (not read from the database), so the
// test checks the database against the spec.
const STATES = [
  'planeada', 'plan_aprobado', 'guion_listo', 'en_produccion', 'en_control_calidad', 'revision_novaciel',
  'esperando_aprobacion', 'aprobada', 'programada', 'publicada', 'en_medicion', 'cerrada', 'con_cambios',
  'rechazada', 'fallo_publicacion', 'pausada',
] as const;
const CHAIN: [string, string][] = [
  ['planeada', 'plan_aprobado'], ['plan_aprobado', 'guion_listo'], ['guion_listo', 'en_produccion'],
  ['en_produccion', 'en_control_calidad'], ['en_control_calidad', 'revision_novaciel'],
  ['revision_novaciel', 'esperando_aprobacion'], ['esperando_aprobacion', 'aprobada'], ['aprobada', 'programada'],
  ['programada', 'publicada'], ['publicada', 'en_medicion'], ['en_medicion', 'cerrada'],
];
const SIDE: [string, string][] = [
  ['en_control_calidad', 'en_produccion'], ['esperando_aprobacion', 'con_cambios'], ['con_cambios', 'en_produccion'],
  ['esperando_aprobacion', 'rechazada'], ['programada', 'fallo_publicacion'], ['fallo_publicacion', 'programada'],
  // Added in Step 9 (ADR-05, spec 11.3): a change after approval or scheduling. NovaCiel only.
  ['aprobada', 'con_cambios'], ['programada', 'con_cambios'],
  // Added in Step 8 (ADR-05): the internal "cambios" decision, now that the internal level decides only in revision_novaciel. NovaCiel only.
  ['revision_novaciel', 'con_cambios'],
];
const TERMINAL = ['cerrada', 'rechazada'];
const PAUSABLE = STATES.filter((s) => s !== 'pausada' && !TERMINAL.includes(s));
const ALLOWED: [string, string][] = [
  ...CHAIN,
  ...SIDE,
  ...PAUSABLE.map((s): [string, string] => [s, 'pausada']),
  ...PAUSABLE.map((s): [string, string] => ['pausada', s]),
];
const key = ([a, b]: [string, string]) => `${a}>${b}`;

describe('transiciones_pieza (section 15)', () => {
  it('has exactly the 46 transitions (the spec plus aprobada, programada and revision_novaciel > con_cambios of Steps 9 and 8)', async () => {
    await withTestTransaction(async (db) => {
      expect(ALLOWED).toHaveLength(46);
      const { rows } = await db.query('SELECT desde, hacia FROM transiciones_pieza');
      expect(rows.map((r) => `${r.desde}>${r.hacia}`).sort()).toEqual(ALLOWED.map(key).sort());
    });
  });

  it('is immutable: no UPDATE, DELETE or TRUNCATE, and no self transition', async () => {
    await withTestTransaction(async (db) => {
      await expectFails(db, /only by migrations/, () => db.query(`UPDATE transiciones_pieza SET hacia = 'cerrada' WHERE desde = 'planeada' AND hacia = 'plan_aprobado'`));
      await expectFails(db, /only by migrations/, () => db.query('DELETE FROM transiciones_pieza'));
      await expectFails(db, /only by migrations/, () => db.query('TRUNCATE transiciones_pieza'));
      await expectFails(db, CHECK_VIOLATION, () => db.query(`INSERT INTO transiciones_pieza (desde, hacia) VALUES ('planeada', 'planeada')`));
    });
  });
});

describe('piece state machine, enforced by the database', () => {
  it('every allowed transition succeeds in SQL', async () => {
    await withTestTransaction(async (db) => {
      const plan = await createPlanSemanal(db);
      for (const [desde, hacia] of ALLOWED) {
        let pieza;
        if (desde === 'pausada') {
          // Resume goes back to wherever the piece was paused from.
          const antes = await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id, estado: hacia });
          await moverPieza(db, antes.id, 'pausada');
          pieza = await moverPieza(db, antes.id, hacia);
          expect(pieza).toMatchObject({ estado: hacia, estado_previo: null });
        } else {
          const antes = await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id, estado: desde });
          pieza = await moverPieza(db, antes.id, hacia);
          expect(pieza.estado, key([desde, hacia])).toBe(hacia);
          expect(pieza.estado_previo).toBe(hacia === 'pausada' ? desde : null);
        }
      }
    });
  });

  it('accepts exactly the allowed pairs: all 16 x 16 combinations', async () => {
    await withTestTransaction(async (db) => {
      const plan = await createPlanSemanal(db);
      const allowed = new Set(ALLOWED.map(key));
      const wrong: string[] = [];
      for (const from of STATES) {
        // A piece paused from a fresh state remembers 'planeada'; that is the only way out of it.
        const pieza = await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id, estado: from });
        for (const to of STATES) {
          if (to === from) continue;
          const expected = from === 'pausada' ? to === 'planeada' : allowed.has(key([from, to]));
          await db.query('SAVEPOINT attempt');
          let accepted = true;
          try {
            await moverPieza(db, pieza.id, to);
          } catch {
            accepted = false;
          }
          await db.query('ROLLBACK TO SAVEPOINT attempt');
          if (accepted !== expected) wrong.push(`${from} -> ${to}: ${accepted ? 'accepted' : 'rejected'}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  });

  it('rejects skipping states, going backwards and leaving the terminal states', async () => {
    await withTestTransaction(async (db) => {
      const plan = await createPlanSemanal(db);
      const cases: [string, string][] = [
        ['planeada', 'guion_listo'], ['aprobada', 'publicada'], ['aprobada', 'planeada'],
        ['en_produccion', 'guion_listo'], ['publicada', 'programada'], ['cerrada', 'en_medicion'],
        ['cerrada', 'pausada'], ['rechazada', 'planeada'], ['rechazada', 'pausada'], ['pausada', 'pausada'],
      ];
      for (const [from, to] of cases) {
        const pieza = await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id, estado: from });
        await expectFails(db, /./, () => moverPieza(db, pieza.id, to));
        expect((await db.query('SELECT estado FROM piezas WHERE id = $1', [pieza.id])).rows[0].estado).toBe(from);
      }
    });
  });

  it('the update trigger itself rejects a target that does not match the history row', async () => {
    await withTestTransaction(async (db) => {
      const pieza = await createPieza(db);
      await insertHistorial(db, pieza.id, pieza.cliente_id, { version: 1, desde: 'planeada', hacia: 'plan_aprobado', actor: { tipo: 'sistema' } });
      await expectFails(db, /./, () => db.query(`UPDATE piezas SET estado = 'guion_listo' WHERE id = $1`, [pieza.id]));
      await expectFails(db, /not an allowed transition/, () => db.query(`UPDATE piezas SET estado = 'cerrada' WHERE id = $1`, [pieza.id]));
      await db.query(`UPDATE piezas SET estado = 'plan_aprobado' WHERE id = $1`, [pieza.id]);
    });
  });

  it('resume goes only to estado_previo, set and cleared by the trigger', async () => {
    await withTestTransaction(async (db) => {
      const plan = await createPlanSemanal(db);
      for (const from of ['guion_listo', 'programada', 'con_cambios', 'fallo_publicacion']) {
        const pieza = await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id, estado: from });
        const paused = await moverPieza(db, pieza.id, 'pausada');
        expect(paused.estado_previo).toBe(from);
        for (const other of PAUSABLE.filter((s) => s !== from)) {
          await expectFails(db, /can only resume to its previous state/, () => moverPieza(db, pieza.id, other));
        }
        const resumed = await moverPieza(db, pieza.id, from);
        expect(resumed).toMatchObject({ estado: from, estado_previo: null });
        expect(resumed.version_estado).toBe(paused.version_estado + 1);
      }
    });
  });

  it('estado_previo is owned by the trigger: a hand-set value is overwritten and a hand edit is refused', async () => {
    await withTestTransaction(async (db) => {
      const pieza = await createPieza(db, { estado: 'aprobada' });
      await insertHistorial(db, pieza.id, pieza.cliente_id, { version: pieza.version_estado + 1, desde: 'aprobada', hacia: 'pausada', actor: { tipo: 'sistema' } });
      const { rows } = await db.query(`UPDATE piezas SET estado = 'pausada', estado_previo = 'guion_listo' WHERE id = $1 RETURNING estado_previo`, [pieza.id]);
      expect(rows[0].estado_previo).toBe('aprobada');
      await expectFails(db, /change only with the state/, () => db.query(`UPDATE piezas SET estado_previo = 'guion_listo' WHERE id = $1`, [pieza.id]));
      await expectFails(db, /change only with the state/, () => db.query('UPDATE piezas SET version_estado = 99 WHERE id = $1', [pieza.id]));
      const other = await createPieza(db);
      await expectFails(db, /change only with the state/, () => db.query(`UPDATE piezas SET estado_previo = 'aprobada' WHERE id = $1`, [other.id]));
    });
  });

  it('every state change needs its own history row, written in the same transaction', async () => {
    await withTestTransaction(async (db) => {
      // No history row at all.
      const pieza = await createPieza(db, { estado: 'programada' });
      await expectFails(db, /needs its history row/, () => db.query(`UPDATE piezas SET estado = 'fallo_publicacion' WHERE id = $1`, [pieza.id]));
    });

    await withTestTransaction(async (db) => {
      // A row that describes another step does not count.
      const pieza = await createPieza(db, { estado: 'programada' });
      await insertHistorial(db, pieza.id, pieza.cliente_id, { version: pieza.version_estado + 1, desde: 'programada', hacia: 'publicada', actor: { tipo: 'sistema' } });
      await expectFails(db, /needs its history row/, () => db.query(`UPDATE piezas SET estado = 'fallo_publicacion' WHERE id = $1`, [pieza.id]));
      await db.query(`UPDATE piezas SET estado = 'publicada' WHERE id = $1`, [pieza.id]);
    });

    await withTestTransaction(async (db) => {
      const pieza = await createPieza(db, { estado: 'programada' });
      const v = pieza.version_estado;
      // A history row forged for another transaction (explicit tx_id) does not count.
      await db.query(
        `INSERT INTO historial_estados_pieza (cliente_id, pieza_id, version, desde, hacia, actor_tipo, tx_id)
         VALUES ($1, $2, $3, 'programada', 'fallo_publicacion', 'sistema', 1)`,
        [pieza.cliente_id, pieza.id, v + 1],
      );
      await expectFails(db, /needs its history row/, () => db.query(`UPDATE piezas SET estado = 'fallo_publicacion' WHERE id = $1`, [pieza.id]));
    });

    await withTestTransaction(async (db) => {
      // One history row cannot be reused for a second change, even with the same pair.
      const pieza = await createPieza(db, { estado: 'programada' });
      await moverPieza(db, pieza.id, 'fallo_publicacion');
      await expectFails(db, /needs its history row/, () => db.query(`UPDATE piezas SET estado = 'programada' WHERE id = $1`, [pieza.id]));
      await moverPieza(db, pieza.id, 'programada');
      await moverPieza(db, pieza.id, 'fallo_publicacion');
      const history = await db.query('SELECT version FROM historial_estados_pieza WHERE pieza_id = $1 ORDER BY version', [pieza.id]);
      expect(history.rows.map((r) => r.version)).toEqual(Array.from({ length: history.rows.length }, (_v, i) => i));
    });
  });

  it('allows editing other columns without a state change', async () => {
    await withTestTransaction(async (db) => {
      const pieza = await createPieza(db, { estado: 'aprobada' });
      await db.query(`UPDATE piezas SET idea = 'Otra idea ficticia', fecha_hora = now() + interval '5 days' WHERE id = $1`, [pieza.id]);
      await db.query('UPDATE piezas SET estado = estado WHERE id = $1', [pieza.id]);
      const { rows } = await db.query('SELECT idea, estado, version_estado FROM piezas WHERE id = $1', [pieza.id]);
      expect(rows[0]).toMatchObject({ idea: 'Otra idea ficticia', estado: 'aprobada', version_estado: pieza.version_estado });
    });
  });

  it('a piece starts in planeada, version 0; client and plan can never change', async () => {
    await withTestTransaction(async (db) => {
      const plan = await createPlanSemanal(db);
      const insert = (estado: string, version = 0) => () =>
        db.query(
          `INSERT INTO piezas (cliente_id, plan_id, red, formato, pilar, trabajo, idea, fecha_hora, estado, version_estado)
           VALUES ($1, $2, 'instagram', 'reel', 'p', 'atraer', 'idea', now(), $3, $4)`,
          [plan.cliente_id, plan.id, estado, version],
        );
      await expectFails(db, /starts in state planeada/, insert('aprobada'));
      await expectFails(db, /starts in state planeada/, insert('planeada', 3));
      await expectFails(db, CHECK_VIOLATION, insert('inventado'));

      const pieza = await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id });
      const otherClient = await createCliente(db);
      const samePlanOther = await createPlanSemanal(db, { clienteId: plan.cliente_id, semanaInicio: '2026-11-09' });
      await expectFails(db, /client and plan cannot change/, () => db.query('UPDATE piezas SET cliente_id = $2 WHERE id = $1', [pieza.id, otherClient.id]));
      await expectFails(db, /client and plan cannot change/, () => db.query('UPDATE piezas SET plan_id = $2 WHERE id = $1', [pieza.id, samePlanOther.id]));
    });
  });

  it('validates network, format, job, pillar and idea', async () => {
    await withTestTransaction(async (db) => {
      const plan = await createPlanSemanal(db);
      const base = { clienteId: plan.cliente_id, planId: plan.id };
      for (const bad of [{ red: 'myspace' }, { formato: 'podcast' }, { trabajo: 'vender' }, { pilar: '  ' }, { idea: '   ' }, { idea: 'x'.repeat(501) }]) {
        await expectFails(db, CHECK_VIOLATION, () => createPieza(db, { ...base, ...bad }));
      }
      for (const ok of [{ red: 'tiktok' }, { formato: 'historia' }, { trabajo: 'confianza' }, { trabajo: 'accion' }, { idea: 'x'.repeat(500) }]) {
        await createPieza(db, { ...base, ...ok });
      }
    });
  });
});

describe('historial_estados_pieza', () => {
  it('is append-only: UPDATE, DELETE and TRUNCATE are rejected', async () => {
    await withTestTransaction(async (db) => {
      const pieza = await createPieza(db);
      await expectFails(db, /append-only/, () => db.query(`UPDATE historial_estados_pieza SET motivo = 'x' WHERE pieza_id = $1`, [pieza.id]));
      await expectFails(db, /append-only/, () => db.query('DELETE FROM historial_estados_pieza WHERE pieza_id = $1', [pieza.id]));
      await expectFails(db, /append-only/, () => db.query('TRUNCATE historial_estados_pieza'));
    });
  });

  it('records creation (NULL -> planeada) and every change with actor and reason', async () => {
    await withTestTransaction(async (db) => {
      const user = await createUsuario(db);
      const pieza = await createPieza(db);
      await moverPieza(db, pieza.id, 'plan_aprobado', { actor: { tipo: 'usuario', usuarioId: user.id }, motivo: 'Aprobada por el cliente' });
      const { rows } = await db.query('SELECT version, desde, hacia, actor_tipo, actor_usuario_id, motivo FROM historial_estados_pieza WHERE pieza_id = $1 ORDER BY version', [pieza.id]);
      expect(rows).toEqual([
        { version: 0, desde: null, hacia: 'planeada', actor_tipo: 'sistema', actor_usuario_id: null, motivo: null },
        { version: 1, desde: 'planeada', hacia: 'plan_aprobado', actor_tipo: 'usuario', actor_usuario_id: user.id, motivo: 'Aprobada por el cliente' },
      ]);
    });
  });

  it('has no foreign keys (so cleanup cannot reach it) but only accepts the next real step of an existing piece of that client', async () => {
    await withTestTransaction(async (db) => {
      const fks = await db.query(
        `SELECT 1 FROM pg_constraint WHERE contype = 'f' AND (conrelid = 'historial_estados_pieza'::regclass OR confrelid = 'historial_estados_pieza'::regclass)`,
      );
      expect(fks.rows).toEqual([]);

      const a = await createPieza(db);
      const b = await createPieza(db);
      const sys = { tipo: 'sistema' } as const;
      // Unknown piece, or the piece of another client.
      await expectFails(db, /does not exist for this client/, () => insertHistorial(db, randomUUID(), a.cliente_id, { version: 1, desde: 'planeada', hacia: 'plan_aprobado', actor: sys }));
      await expectFails(db, /does not exist for this client/, () => insertHistorial(db, b.id, a.cliente_id, { version: 1, desde: 'planeada', hacia: 'plan_aprobado', actor: sys }));
      // Not an allowed transition, a skipped version, a wrong current state, a second creation row.
      await expectFails(db, /not an allowed transition/, () => insertHistorial(db, a.id, a.cliente_id, { version: 1, desde: 'planeada', hacia: 'guion_listo', actor: sys }));
      await expectFails(db, /does not follow the current state/, () => insertHistorial(db, a.id, a.cliente_id, { version: 2, desde: 'planeada', hacia: 'plan_aprobado', actor: sys }));
      await expectFails(db, /does not follow the current state/, () => insertHistorial(db, a.id, a.cliente_id, { version: 1, desde: 'aprobada', hacia: 'programada', actor: sys }));
      await expectFails(db, UNIQUE_VIOLATION, () => insertHistorial(db, a.id, a.cliente_id, { version: 0, desde: null, hacia: 'planeada', actor: sys }));
      // Shape checks.
      await expectFails(db, /./, () => insertHistorial(db, a.id, a.cliente_id, { version: 1, desde: null, hacia: 'plan_aprobado', actor: sys }));
      await expectFails(db, CHECK_VIOLATION, () =>
        db.query(`INSERT INTO historial_estados_pieza (cliente_id, pieza_id, version, desde, hacia, actor_tipo) VALUES ($1, $2, 1, 'planeada', 'plan_aprobado', 'usuario')`, [a.cliente_id, a.id]),
      );
    });
  });
});

describe('plans and links', () => {
  it('one non-discarded plan per client and week; free again once discarded; other clients and weeks are independent', async () => {
    await withTestTransaction(async (db) => {
      const first = await createPlanSemanal(db);
      await expectFails(db, UNIQUE_VIOLATION, () => createPlanSemanal(db, { clienteId: first.cliente_id }));
      await expectFails(db, UNIQUE_VIOLATION, () => createPlanSemanal(db, { clienteId: first.cliente_id, estado: 'aprobado' }));
      await createPlanSemanal(db, { clienteId: first.cliente_id, semanaInicio: '2026-11-09' });
      await createPlanSemanal(db); // another client, same week
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [first.id]);
      const replacement = await createPlanSemanal(db, { clienteId: first.cliente_id });
      expect(replacement.id).not.toBe(first.id);
      await createPlanSemanal(db, { clienteId: first.cliente_id, estado: 'descartado' }); // several discarded ones are fine
    });
  });

  it('the week must start on a Monday, with a known state and a time zone', async () => {
    await withTestTransaction(async (db) => {
      for (const semanaInicio of ['2026-11-03', '2026-11-08', '2026-11-01']) {
        await expectFails(db, CHECK_VIOLATION, () => createPlanSemanal(db, { semanaInicio }));
      }
      await expectFails(db, CHECK_VIOLATION, () => createPlanSemanal(db, { estado: 'enviado' as never }));
      await expectFails(db, CHECK_VIOLATION, () => createPlanSemanal(db, { zonaHoraria: '  ' }));
    });
  });

  it('a discarded plan is terminal, and the week, client, zone and profile version never change', async () => {
    await withTestTransaction(async (db) => {
      const plan = await createPlanSemanal(db);
      const other = await createPerfilMarca(db, { clienteId: plan.cliente_id, version: 5, esActual: false });
      await expectFails(db, /cannot change/, () => db.query(`UPDATE planes_semanales SET semana_inicio = '2026-11-09' WHERE id = $1`, [plan.id]));
      await expectFails(db, /cannot change/, () => db.query(`UPDATE planes_semanales SET zona_horaria = 'America/Chicago' WHERE id = $1`, [plan.id]));
      await expectFails(db, /cannot change/, () => db.query('UPDATE planes_semanales SET perfil_marca_id = $2 WHERE id = $1', [plan.id, other.id]));
      await db.query(`UPDATE planes_semanales SET estado = 'propuesto' WHERE id = $1`, [plan.id]);
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [plan.id]);
      await expectFails(db, /discarded plan cannot change state/, () => db.query(`UPDATE planes_semanales SET estado = 'borrador' WHERE id = $1`, [plan.id]));
    });
  });

  it("a plan cannot point to another client's profile version, and a piece cannot belong to another client's plan", async () => {
    await withTestTransaction(async (db) => {
      const a = await createPlanSemanal(db);
      const b = await createPlanSemanal(db);
      const bProfile = (await db.query('SELECT id FROM perfil_marca WHERE cliente_id = $1', [b.cliente_id])).rows[0].id;
      await expectFails(db, FK_VIOLATION, () => createPlanSemanal(db, { clienteId: a.cliente_id, semanaInicio: '2026-11-09', perfilMarcaId: bProfile }));
      await expectFails(db, FK_VIOLATION, () =>
        db.query(
          `INSERT INTO piezas (cliente_id, plan_id, red, formato, pilar, trabajo, idea, fecha_hora) VALUES ($1, $2, 'instagram', 'reel', 'p', 'atraer', 'idea', now())`,
          [a.cliente_id, b.id],
        ),
      );
    });
  });

  it("a piece cannot cite another client's fact, nor the same fact twice; cited facts cannot be removed", async () => {
    await withTestTransaction(async (db) => {
      const pieza = await createPieza(db);
      const own = await createHechoVerificado(db, { clienteId: pieza.cliente_id, verificadoPor: (await createUsuario(db)).id });
      const foreign = await createHechoVerificado(db, { verificadoPor: (await createUsuario(db)).id });
      await createPiezaHecho(db, { piezaId: pieza.id, hechoId: own.id, clienteId: pieza.cliente_id });
      await expectFails(db, UNIQUE_VIOLATION, () => createPiezaHecho(db, { piezaId: pieza.id, hechoId: own.id, clienteId: pieza.cliente_id }));
      await expectFails(db, FK_VIOLATION, () => createPiezaHecho(db, { piezaId: pieza.id, hechoId: foreign.id, clienteId: pieza.cliente_id }));
      await expectFails(db, FK_VIOLATION, () => createPiezaHecho(db, { piezaId: pieza.id, hechoId: foreign.id, clienteId: foreign.cliente_id }));
      await expectFails(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM hechos_verificados WHERE id = $1', [own.id]));
      await expectFails(db, RESTRICT_VIOLATION, () => db.query('DELETE FROM piezas WHERE id = $1', [pieza.id]));
    });
  });
});

describe('isolation: plans and pieces', () => {
  it('rows of two clients stay separate by cliente_id', async () => {
    await withTestTransaction(async (db) => {
      const a = await createPieza(db);
      const b = await createPieza(db);
      const piezasOfB = await db.query('SELECT id FROM piezas WHERE cliente_id = $1', [b.cliente_id]);
      const historyOfB = await db.query('SELECT pieza_id FROM historial_estados_pieza WHERE cliente_id = $1', [b.cliente_id]);
      expect(piezasOfB.rows.map((r) => r.id)).toEqual([b.id]);
      expect(historyOfB.rows.map((r) => r.pieza_id)).toEqual([b.id]);
      expect((await db.query('SELECT 1 FROM planes_semanales WHERE cliente_id = $1', [a.cliente_id])).rows).toHaveLength(1);
    });
  });
});
