import { describe, expect, it } from 'vitest';
import { withTestTransaction as withTx } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import {
  createCliente,
  createHechoVerificado,
  createPieza,
  createPiezaHecho,
  createPlanSemanal,
  createUsuario,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';

// These tests are about the generic state machine, not about approvals: they may enter `aprobada` and
// `programada` without approval records (the approval guard has its own tests in aprobaciones.test.ts).
const withTestTransaction = <T>(fn: Parameters<typeof withTx<T>>[0]) => withTx(fn, { sinGuardaDeAprobacion: true });
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import {
  ALLOWED_TRANSITIONS,
  ESTADOS,
  getHistorial,
  getPieza,
  InvalidPiezaInputError,
  InvalidTransitionError,
  listPiezas,
  NotPausedError,
  pausarPieza,
  PiezaNotFoundError,
  reanudarPieza,
  transitionPieza,
  type EstadoPieza,
} from './index.js';

const SISTEMA = { tipo: 'sistema' } as const;

// The section 15 transitions, written out by hand HERE (not imported from the code under test).
const SPEC_CHAIN = [
  'planeada>plan_aprobado', 'plan_aprobado>guion_listo', 'guion_listo>en_produccion', 'en_produccion>en_control_calidad',
  'en_control_calidad>revision_novaciel', 'revision_novaciel>esperando_aprobacion', 'esperando_aprobacion>aprobada',
  'aprobada>programada', 'programada>publicada', 'publicada>en_medicion', 'en_medicion>cerrada',
  'en_control_calidad>en_produccion', 'esperando_aprobacion>con_cambios', 'con_cambios>en_produccion',
  'esperando_aprobacion>rechazada', 'programada>fallo_publicacion', 'fallo_publicacion>programada',
  // Added in Step 9 (ADR-05, spec 11.3): a change after approval or scheduling. NovaCiel only.
  'aprobada>con_cambios', 'programada>con_cambios',
  // Added in Step 8 (ADR-05): the internal "cambios" decision from revision_novaciel. NovaCiel only.
  'revision_novaciel>con_cambios',
];
const PAUSABLE = ESTADOS.filter((s) => s !== 'pausada' && s !== 'cerrada' && s !== 'rechazada');
const SPEC_ALLOWED = new Set([...SPEC_CHAIN, ...PAUSABLE.map((s) => `${s}>pausada`), ...PAUSABLE.map((s) => `pausada>${s}`)]);

async function newClient(db: Db): Promise<ClienteId> {
  return asClienteId((await createCliente(db)).id);
}

describe('ALLOWED_TRANSITIONS', () => {
  it('has the 46 transitions (section 15 plus aprobada, programada and revision_novaciel > con_cambios of Steps 9 and 8) and agrees exactly with the database table', async () => {
    await withTestTransaction(async (db) => {
      expect(ALLOWED_TRANSITIONS).toHaveLength(46);
      const inCode = ALLOWED_TRANSITIONS.map(([d, h]) => `${d}>${h}`).sort();
      const { rows } = await db.query('SELECT desde, hacia FROM transiciones_pieza');
      const inDatabase = rows.map((r) => `${r.desde}>${r.hacia}`).sort();
      expect(inCode).toEqual(inDatabase);
      expect(inCode).toEqual([...SPEC_ALLOWED].sort());
    });
  });

  it('knows the same 16 states as the database domain', async () => {
    await withTestTransaction(async (db) => {
      expect(ESTADOS).toHaveLength(16);
      for (const estado of ESTADOS) await db.query('SELECT $1::estado_pieza', [estado]);
      await db.query('SAVEPOINT bad_state');
      await expect(db.query(`SELECT 'inventado'::estado_pieza`)).rejects.toMatchObject({ code: '23514' });
      await db.query('ROLLBACK TO SAVEPOINT bad_state');
    });
  });
});

describe('transitionPieza', () => {
  // Measured 3.2 s idle (all allowed transitions in one test); 15 s leaves room when the machine is busy.
  it('every allowed transition succeeds through the service, with one history row and one audit row', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const plan = await createPlanSemanal(db, { clienteId });
      const user = await createUsuario(db);
      for (const [desde, hacia] of ALLOWED_TRANSITIONS) {
        const actor = hacia === 'pausada' ? { tipo: 'usuario' as const, usuarioId: user.id } : SISTEMA;
        let pieza;
        if (desde === 'pausada') {
          pieza = await createPieza(db, { clienteId, planId: plan.id, estado: hacia });
          await pausarPieza(db, clienteId, pieza.id, SISTEMA);
        } else {
          pieza = await createPieza(db, { clienteId, planId: plan.id, estado: desde });
        }
        const before = await getHistorial(db, clienteId, pieza.id);
        const after = await transitionPieza(db, clienteId, pieza.id, hacia, actor);
        expect(after.estado, `${desde}>${hacia}`).toBe(hacia);

        const history = await getHistorial(db, clienteId, pieza.id);
        expect(history).toHaveLength(before.length + 1);
        expect(history.at(-1)).toMatchObject({
          version: after.version_estado,
          desde,
          hacia,
          actor_tipo: actor.tipo,
          actor_usuario_id: actor.tipo === 'usuario' ? user.id : null,
        });
        const audit = (await auditRowsFor(db, 'piezas', pieza.id)).filter((a) => a.accion === 'cambiar_estado');
        expect(audit.at(-1)).toMatchObject({
          cliente_id: clienteId,
          actor_tipo: actor.tipo,
          datos_antes: { estado: desde },
          datos_despues: { estado: hacia, version_estado: after.version_estado },
        });
        expect(audit.length).toBeGreaterThanOrEqual(1); // the service wrote one audit row for this change
      }
    });
  }, 15_000);

  // Measured 2.2 s idle (16 x 16 pairs in one test); 15 s leaves room when the machine is busy.
  it('rejects every disallowed pair in the service, before the database (all 16 x 16)', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const plan = await createPlanSemanal(db, { clienteId });
      const wrong: string[] = [];
      for (const from of ESTADOS) {
        // A piece paused from a fresh state remembers 'planeada': the only way out of 'pausada'.
        const pieza = await createPieza(db, { clienteId, planId: plan.id, estado: from });
        for (const to of ESTADOS) {
          const expected = from === 'pausada' ? to === 'planeada' : SPEC_ALLOWED.has(`${from}>${to}`);
          await db.query('SAVEPOINT attempt');
          const writes: string[] = [];
          const spy: Db = {
            query: ((text: unknown, params?: unknown) => {
              const sql = String(typeof text === 'string' ? text : (text as { text: string }).text);
              if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql);
              return db.query(text as never, params as never);
            }) as Db['query'],
          };
          let outcome: 'accepted' | 'invalid' | 'other' = 'accepted';
          try {
            await transitionPieza(spy, clienteId, pieza.id, to, SISTEMA);
          } catch (error) {
            outcome = error instanceof InvalidTransitionError ? 'invalid' : 'other';
            if (error instanceof InvalidTransitionError) expect(error).toMatchObject({ desde: from, hacia: to });
          }
          await db.query('ROLLBACK TO SAVEPOINT attempt');
          if (expected && outcome !== 'accepted') wrong.push(`${from} -> ${to}: should be accepted, was ${outcome}`);
          if (!expected && outcome !== 'invalid') wrong.push(`${from} -> ${to}: should be rejected by the service, was ${outcome}`);
          if (!expected && writes.length > 0) wrong.push(`${from} -> ${to}: the service wrote before rejecting`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }, 15_000);

  it('the error and the state it leaves behind contain no content', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const pieza = await createPieza(db, { clienteId, idea: 'IDEA-PRIVADA-DEL-CLIENTE', estado: 'aprobada' });
      const error = await transitionPieza(db, clienteId, pieza.id, 'planeada', SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as Error).message).toBe('Invalid piece transition: aprobada -> planeada');
      expect((await getPieza(db, clienteId, pieza.id))!.estado).toBe('aprobada');
      expect((await getHistorial(db, clienteId, pieza.id)).at(-1)!.hacia).toBe('aprobada');
    });
  });

  it('records and trims the reason, and refuses an empty or over-long one without writing', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const pieza = await createPieza(db, { clienteId });
      await transitionPieza(db, clienteId, pieza.id, 'plan_aprobado', SISTEMA, { motivo: '  Aprobada en la reunión  ' });
      expect((await getHistorial(db, clienteId, pieza.id)).at(-1)!.motivo).toBe('Aprobada en la reunión');
      const audit = (await auditRowsFor(db, 'piezas', pieza.id)).at(-1)!;
      expect(audit.datos_despues).toMatchObject({ motivo: 'Aprobada en la reunión' });

      for (const motivo of ['', '   ', 'x'.repeat(501)]) {
        await expect(transitionPieza(db, clienteId, pieza.id, 'guion_listo', SISTEMA, { motivo })).rejects.toBeInstanceOf(InvalidPiezaInputError);
      }
      expect((await getPieza(db, clienteId, pieza.id))!.estado).toBe('plan_aprobado');
      expect(await getHistorial(db, clienteId, pieza.id)).toHaveLength(2);
    });
  });
});

describe('pausarPieza and reanudarPieza', () => {
  it('a round trip returns to the state it was paused from, from several different states', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const plan = await createPlanSemanal(db, { clienteId });
      for (const from of ['planeada', 'guion_listo', 'programada', 'con_cambios', 'fallo_publicacion', 'publicada'] as EstadoPieza[]) {
        const pieza = await createPieza(db, { clienteId, planId: plan.id, estado: from });
        const paused = await pausarPieza(db, clienteId, pieza.id, SISTEMA, { motivo: 'Interruptor general' });
        expect(paused).toMatchObject({ estado: 'pausada', estado_previo: from });
        const resumed = await reanudarPieza(db, clienteId, pieza.id, SISTEMA);
        expect(resumed).toMatchObject({ estado: from, estado_previo: null });
        expect(resumed.version_estado).toBe(paused.version_estado + 1);
      }
    });
  });

  it('works twice in a row and the second pause remembers the state again', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const pieza = await createPieza(db, { clienteId, estado: 'en_produccion' });
      await pausarPieza(db, clienteId, pieza.id, SISTEMA);
      await reanudarPieza(db, clienteId, pieza.id, SISTEMA);
      await transitionPieza(db, clienteId, pieza.id, 'en_control_calidad', SISTEMA);
      const second = await pausarPieza(db, clienteId, pieza.id, SISTEMA);
      expect(second.estado_previo).toBe('en_control_calidad');
      expect(await reanudarPieza(db, clienteId, pieza.id, SISTEMA)).toMatchObject({ estado: 'en_control_calidad' });
    });
  });

  it('resuming a piece that is not paused is rejected, in any state', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const plan = await createPlanSemanal(db, { clienteId });
      for (const estado of ESTADOS.filter((s) => s !== 'pausada')) {
        const pieza = await createPieza(db, { clienteId, planId: plan.id, estado });
        const error = await reanudarPieza(db, clienteId, pieza.id, SISTEMA).catch((e: unknown) => e);
        expect(error, estado).toBeInstanceOf(NotPausedError);
        expect(error).toMatchObject({ estado });
        expect((await getPieza(db, clienteId, pieza.id))!.estado).toBe(estado);
      }
    });
  });

  it('pausing a terminal or an already paused piece is an invalid transition; a paused piece resumes only to estado_previo', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const plan = await createPlanSemanal(db, { clienteId });
      for (const estado of ['cerrada', 'rechazada', 'pausada'] as EstadoPieza[]) {
        const pieza = await createPieza(db, { clienteId, planId: plan.id, estado });
        await expect(pausarPieza(db, clienteId, pieza.id, SISTEMA)).rejects.toBeInstanceOf(InvalidTransitionError);
      }
      const pieza = await createPieza(db, { clienteId, planId: plan.id, estado: 'aprobada' });
      await pausarPieza(db, clienteId, pieza.id, SISTEMA);
      for (const other of PAUSABLE.filter((s) => s !== 'aprobada')) {
        await expect(transitionPieza(db, clienteId, pieza.id, other as EstadoPieza, SISTEMA)).rejects.toBeInstanceOf(InvalidTransitionError);
      }
      expect(await transitionPieza(db, clienteId, pieza.id, 'aprobada', SISTEMA)).toMatchObject({ estado: 'aprobada', estado_previo: null });
    });
  });
});

describe('reads', () => {
  it('getPieza returns the piece with its cited facts; unknown ids give null', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const pieza = await createPieza(db, { clienteId });
      const verificadoPor = (await createUsuario(db)).id;
      const h1 = await createHechoVerificado(db, { clienteId, verificadoPor });
      const h2 = await createHechoVerificado(db, { clienteId, verificadoPor });
      await createPiezaHecho(db, { piezaId: pieza.id, hechoId: h1.id, clienteId });
      await createPiezaHecho(db, { piezaId: pieza.id, hechoId: h2.id, clienteId });
      const read = (await getPieza(db, clienteId, pieza.id))!;
      expect(read).toMatchObject({ id: pieza.id, estado: 'planeada', estado_previo: null, version_estado: 0 });
      expect([...read.hecho_ids].sort()).toEqual([h1.id, h2.id].sort());
      expect(await getPieza(db, clienteId, '00000000-0000-4000-8000-000000000000')).toBeNull();
    });
  });

  it('listPiezas filters by plan, state(s) and time range, ordered by scheduled time', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const planA = await createPlanSemanal(db, { clienteId, semanaInicio: '2026-11-02' });
      const planB = await createPlanSemanal(db, { clienteId, semanaInicio: '2026-11-09' });
      const at = (iso: string) => new Date(iso);
      const p1 = await createPieza(db, { clienteId, planId: planA.id, fechaHora: at('2026-11-03T15:00:00Z') });
      const p2 = await createPieza(db, { clienteId, planId: planA.id, fechaHora: at('2026-11-04T15:00:00Z'), estado: 'aprobada' });
      const p3 = await createPieza(db, { clienteId, planId: planB.id, fechaHora: at('2026-11-10T15:00:00Z'), estado: 'pausada' });
      const ids = async (f: Parameters<typeof listPiezas>[2]) => (await listPiezas(db, clienteId, f)).map((p) => p.id);

      expect(await ids({})).toEqual([p1.id, p2.id, p3.id]);
      expect(await ids({ planId: planA.id })).toEqual([p1.id, p2.id]);
      expect(await ids({ estado: 'aprobada' })).toEqual([p2.id]);
      expect(await ids({ estado: ['aprobada', 'pausada'] })).toEqual([p2.id, p3.id]);
      expect(await ids({ estado: [] })).toEqual([]);
      expect(await ids({ desde: at('2026-11-04T15:00:00Z') })).toEqual([p2.id, p3.id]); // inclusive
      expect(await ids({ hasta: at('2026-11-04T15:00:00Z') })).toEqual([p1.id]); // exclusive
      expect(await ids({ planId: planA.id, estado: 'planeada', desde: at('2026-11-03T00:00:00Z'), hasta: at('2026-11-04T00:00:00Z') })).toEqual([p1.id]);
    });
  });

  it('getHistorial returns the creation row and every change, oldest first', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await newClient(db);
      const pieza = await createPieza(db, { clienteId });
      await transitionPieza(db, clienteId, pieza.id, 'plan_aprobado', SISTEMA);
      await pausarPieza(db, clienteId, pieza.id, SISTEMA);
      await reanudarPieza(db, clienteId, pieza.id, SISTEMA);
      const history = await getHistorial(db, clienteId, pieza.id);
      expect(history.map((h) => [h.version, h.desde, h.hacia])).toEqual([
        [0, null, 'planeada'], [1, 'planeada', 'plan_aprobado'], [2, 'plan_aprobado', 'pausada'], [3, 'pausada', 'plan_aprobado'],
      ]);
    });
  });
});

describe('isolation: pieces', () => {
  it("client A cannot transition, pause, resume, read, list or see the history of B's pieces", async () => {
    await withTestTransaction(async (db) => {
      const a = await newClient(db);
      const b = await newClient(db);
      const pieza = await createPieza(db, { clienteId: b, estado: 'aprobada' });
      const auditBefore = Number((await db.query('SELECT count(*) AS n FROM auditoria WHERE cliente_id = $1', [b])).rows[0].n);
      const historyBefore = await getHistorial(db, b, pieza.id);

      await expect(transitionPieza(db, a, pieza.id, 'programada', SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      await expect(pausarPieza(db, a, pieza.id, SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      await expect(reanudarPieza(db, a, pieza.id, SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(await getPieza(db, a, pieza.id)).toBeNull();
      expect(await listPiezas(db, a)).toEqual([]);
      expect(await getHistorial(db, a, pieza.id)).toEqual([]);

      expect((await getPieza(db, b, pieza.id))!.estado).toBe('aprobada');
      expect(await getHistorial(db, b, pieza.id)).toEqual(historyBefore);
      expect(Number((await db.query('SELECT count(*) AS n FROM auditoria WHERE cliente_id = $1', [b])).rows[0].n)).toBe(auditBefore);
    });
  });
});
