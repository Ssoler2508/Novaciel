import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  assignRole,
  createAprobableWorld,
  createAprobacion,
  createAprobacionPlan,
  createAprobadoresCliente,
  createCliente,
  createPieza,
  createPlanSemanal,
  createProduccion,
  createUsuarioConRol,
  insertHistorial,
  moverPieza,
  planHuella,
} from '../../tests/utils/factories/index.js';
import type { Db } from './types.js';

/** Expects `run` to fail with a message matching `match`, keeping the surrounding transaction usable. */
async function expectFails(db: Db, match: string | RegExp, run: () => Promise<unknown>): Promise<void> {
  await db.query('SAVEPOINT expect_fails');
  await expect(run()).rejects.toThrow(match);
  await db.query('ROLLBACK TO SAVEPOINT expect_fails');
}

/** A world whose piece is waiting for the client: the internal level is approved and the piece moved on. */
async function worldWaitingForClient(db: Db) {
  const w = await createAprobableWorld(db, { estado: 'revision_novaciel' });
  const interno = await createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno' });
  await moverPieza(db, w.piezaId, 'esperando_aprobacion');
  return { ...w, interno };
}

describe('aprobaciones: append-only (Step 9)', () => {
  it('refuses UPDATE, DELETE and TRUNCATE of piece decisions, also outside the test cleanup flag', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db);
      const a = await createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno' });
      await expectFails(db, /append-only/, () => db.query('UPDATE aprobaciones SET comentario = $2 WHERE id = $1', [a.id, 'otro']));
      await expectFails(db, /append-only/, () => db.query("UPDATE aprobaciones SET decision = 'rechazada' WHERE id = $1", [a.id]));
      await expectFails(db, /append-only/, () => db.query('DELETE FROM aprobaciones WHERE id = $1', [a.id]));
      await expectFails(db, /append-only/, () => db.query('TRUNCATE aprobaciones'));
      expect((await db.query('SELECT 1 FROM aprobaciones WHERE id = $1', [a.id])).rows).toHaveLength(1);
    });
  });
  it('refuses UPDATE, DELETE and TRUNCATE of plan decisions', async () => {
    await withTestTransaction(async (db) => {
      const plan = await createPlanSemanal(db, { estado: 'propuesto' });
      await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id });
      const d = await createAprobacionPlan(db, { planId: plan.id });
      await expectFails(db, /append-only/, () => db.query("UPDATE aprobaciones_plan SET decision = 'rechazado', motivo = 'otro' WHERE id = $1", [d.id]));
      await expectFails(db, /append-only/, () => db.query('DELETE FROM aprobaciones_plan WHERE id = $1', [d.id]));
      await expectFails(db, /append-only/, () => db.query('TRUNCATE aprobaciones_plan'));
    });
  });

});

describe('aprobaciones: the decision binds to the exact current production', () => {
  it('records an internal approval of the current production, in en_control_calidad and in revision_novaciel', async () => {
    await withTestTransaction(async (db) => {
      const w1 = await createAprobableWorld(db);
      const a = await createAprobacion(db, { piezaId: w1.piezaId, nivel: 'interno' });
      expect(a.produccion_id).toBe(w1.produccionId);
      const w2 = await createAprobableWorld(db, { estado: 'revision_novaciel' });
      await expect(createAprobacion(db, { piezaId: w2.piezaId, nivel: 'interno' })).resolves.toMatchObject({ nivel: 'interno', decision: 'aprobada' });
    });
  });

  it('refuses a hash that is not the stored hash of the production', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db);
      await expectFails(db, /does not match the current production/, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', hashPieza: randomBytes(32) }));
    });
  });

  it('refuses another version or another hash version', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db);
      await expectFails(db, /does not match the current production/, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', version: 2 }));
      await expectFails(db, /does not match the current production|check/i, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', hashVersion: 'np2' }));
    });
  });

  it('refuses a production that is no longer the current one (a new version voids the old target)', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db);
      const old = await db.query<{ version: number; hash_pieza: Buffer }>('SELECT version, hash_pieza FROM producciones WHERE id = $1', [w.produccionId]);
      await createProduccion(db, { piezaId: w.piezaId });
      await expectFails(db, /only the current production/, () =>
        createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', produccionId: w.produccionId, version: old.rows[0]!.version, hashPieza: old.rows[0]!.hash_pieza }),
      );
      // The new current production can be approved.
      await expect(createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno' })).resolves.toMatchObject({ nivel: 'interno' });
    });
  });

  it("refuses a production that belongs to another piece or another client", async () => {
    await withTestTransaction(async (db) => {
      const a = await createAprobableWorld(db);
      // Another piece of the same client (another week, so another plan).
      const sameClient = await createAprobableWorld(db, { clienteId: a.clienteId, semanaInicio: '2027-01-04' });
      await expectFails(db, /belongs to another piece/, () => createAprobacion(db, { piezaId: a.piezaId, nivel: 'interno', produccionId: sameClient.produccionId }));
      const b = await createAprobableWorld(db);
      await expectFails(db, /does not exist for this client/, () => createAprobacion(db, { piezaId: a.piezaId, nivel: 'interno', produccionId: b.produccionId }));
      // Same piece id with B's production through A's client id: the composite key refuses it.
      const user = await createUsuarioConRol(db, 'administrador_novaciel');
      const prodB = (await db.query<{ version: number; hash_pieza: Buffer }>('SELECT version, hash_pieza FROM producciones WHERE id = $1', [b.produccionId])).rows[0]!;
      await expectFails(db, /./, () =>
        db.query(
          `INSERT INTO aprobaciones (cliente_id, pieza_id, produccion_id, version, hash_version, hash_pieza, nivel, decision, usuario_id, rol_id)
           VALUES ($1, $2, $3, $4, 'np1', $5, 'interno', 'aprobada', $6, (SELECT id FROM roles WHERE codigo = 'administrador_novaciel'))`,
          [a.clienteId, b.piezaId, b.produccionId, prodB.version, prodB.hash_pieza, user.id],
        ),
      );
    });
  });

  it('checks the state of the piece for each level', async () => {
    await withTestTransaction(async (db) => {
      const waiting = await worldWaitingForClient(db);
      await expectFails(db, /cannot get an internal decision/, () => createAprobacion(db, { piezaId: waiting.piezaId, nivel: 'interno' }));
      const early = await createAprobableWorld(db);
      await expectFails(db, /cannot get a client decision/, () => createAprobacion(db, { piezaId: early.piezaId, nivel: 'cliente' }));
    });
  });
});

describe('aprobaciones: who may record which level (database level)', () => {
  it('records the client level for an approver of THAT client, with either approval role', async () => {
    await withTestTransaction(async (db) => {
      const w = await worldWaitingForClient(db);
      const c = await createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', rolCodigo: 'dueno_cliente' });
      expect(c).toMatchObject({ nivel: 'cliente', decision: 'aprobada' });
      const w2 = await worldWaitingForClient(db);
      await expect(createAprobacion(db, { piezaId: w2.piezaId, nivel: 'cliente', rolCodigo: 'aprobador_cliente' })).resolves.toMatchObject({ nivel: 'cliente' });
    });
  });

  it('refuses the client level for a NovaCiel user using a NovaCiel role', async () => {
    await withTestTransaction(async (db) => {
      const w = await worldWaitingForClient(db);
      for (const rolCodigo of ['administrador_novaciel', 'operador_novaciel']) {
        const staff = await createUsuarioConRol(db, rolCodigo);
        await expectFails(db, /client level needs the role/, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', usuarioId: staff.id, rolCodigo }));
      }
    });
  });

  it('refuses the client level for a NovaCiel user who ALSO holds a client role for that client', async () => {
    await withTestTransaction(async (db) => {
      const w = await worldWaitingForClient(db);
      const staff = await createUsuarioConRol(db, 'administrador_novaciel');
      await assignRole(db, { usuarioId: staff.id, rolCodigo: 'aprobador_cliente', clienteId: w.clienteId });
      await expectFails(db, /NovaCiel staff cannot record the client level/, () =>
        createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', usuarioId: staff.id, rolCodigo: 'aprobador_cliente' }),
      );
    });
  });

  it("refuses the client level for another client's approver", async () => {
    await withTestTransaction(async (db) => {
      const w = await worldWaitingForClient(db);
      const other = await createCliente(db);
      const foreign = await createUsuarioConRol(db, 'aprobador_cliente', other.id);
      await expectFails(db, /does not hold that approval role for this client/, () =>
        createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', usuarioId: foreign.id, rolCodigo: 'aprobador_cliente' }),
      );
    });
  });

  it('refuses colaborador_cliente, an inactive user, and a role the user does not hold', async () => {
    await withTestTransaction(async (db) => {
      const w = await worldWaitingForClient(db);
      const colab = await createUsuarioConRol(db, 'colaborador_cliente', w.clienteId);
      await expectFails(db, /client level needs the role/, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', usuarioId: colab.id, rolCodigo: 'colaborador_cliente' }));
      const inactive = await createUsuarioConRol(db, 'aprobador_cliente', w.clienteId);
      await db.query('UPDATE usuarios SET activo = false WHERE id = $1', [inactive.id]);
      await expectFails(db, /not active/, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', usuarioId: inactive.id, rolCodigo: 'aprobador_cliente' }));
      const owner = await createUsuarioConRol(db, 'dueno_cliente', w.clienteId);
      await expectFails(db, /does not hold that approval role/, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', usuarioId: owner.id, rolCodigo: 'aprobador_cliente' }));
    });
  });

  it('refuses the internal level for a client user', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db);
      const client = await createUsuarioConRol(db, 'aprobador_cliente', w.clienteId);
      await expectFails(db, /internal level needs a NovaCiel approval role/, () =>
        createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', usuarioId: client.id, rolCodigo: 'aprobador_cliente' }),
      );
    });
  });
});

describe('aprobaciones: internal before client', () => {
  it('refuses a client approval with no internal approval of the same production', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db, { estado: 'esperando_aprobacion' });
      await expectFails(db, /before the internal approval/, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente' }));
    });
  });

  it('refuses a client approval when the internal approval was of an older production', async () => {
    await withTestTransaction(async (db) => {
      // NovaCiel approved version 1; then a version 2 was produced and the piece moved on to the client.
      const w = await createAprobableWorld(db);
      await createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno' });
      await createProduccion(db, { piezaId: w.piezaId });
      await moverPieza(db, w.piezaId, 'revision_novaciel');
      await moverPieza(db, w.piezaId, 'esperando_aprobacion');
      await expectFails(db, /before the internal approval/, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente' }));
    });
  });

  it('refuses a client approval after a newer change request, until NovaCiel approves again', async () => {
    await withTestTransaction(async (db) => {
      const w = await worldWaitingForClient(db);
      const cambios = await createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', decision: 'cambios', motivo: 'texto' });
      expect(BigInt(cambios.seq)).toBeGreaterThan(BigInt(w.interno.seq));
      await expectFails(db, /change request is newer/, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente' }));
    });
  });

  it('allows a client rejection before any approval, and the order of decisions is seq, not time', async () => {
    await withTestTransaction(async (db) => {
      const w = await worldWaitingForClient(db);
      const rechazo = await createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente', decision: 'rechazada', motivo: 'otro', comentario: 'Comentario ficticio' });
      expect(rechazo.decision).toBe('rechazada');
      const w2 = await worldWaitingForClient(db);
      const ok = await createAprobacion(db, { piezaId: w2.piezaId, nivel: 'cliente' });
      expect(BigInt(ok.seq)).toBeGreaterThan(BigInt(w2.interno.seq));
    });
  });
});

describe('aprobaciones: column rules', () => {
  it('only the client can reject; an approval has no reason; a change request or rejection has one', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db);
      await expectFails(db, /check/i, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', decision: 'rechazada', motivo: 'otro' }));
      await expectFails(db, /check/i, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', motivo: 'texto' }));
      await expectFails(db, /check/i, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', decision: 'cambios', motivo: null }));
      await expectFails(db, /check/i, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', segundoMs: 1000 })); // only on a change request
      await expect(createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', decision: 'cambios', motivo: 'gancho', segundoMs: 4500 })).resolves.toMatchObject({ segundo_ms: 4500 });
    });
  });

  it('dispositivo is a short coarse label: at most 40 characters, never a full user agent', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db);
      const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      await expectFails(db, /check/i, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', dispositivo: userAgent }));
      await expectFails(db, /check/i, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', dispositivo: '   ' }));
      await expect(createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', dispositivo: 'movil · Safari' })).resolves.toMatchObject({ dispositivo: 'movil · Safari' });
    });
  });

  it('refuses an empty or oversized comment', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db);
      await expectFails(db, /check/i, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', decision: 'cambios', comentario: '  ' }));
      await expectFails(db, /check/i, () => createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno', decision: 'cambios', comentario: 'x'.repeat(2001) }));
    });
  });
});

describe('aprobaciones_plan: the client decides on the plan fingerprint', () => {
  async function proposedPlan(db: Db) {
    const plan = await createPlanSemanal(db, { estado: 'propuesto' });
    const pieza = await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id });
    return { plan, pieza };
  }

  it('records an approval, a change request and a rejection from an approver of the client', async () => {
    await withTestTransaction(async (db) => {
      const { plan } = await proposedPlan(db);
      await expect(createAprobacionPlan(db, { planId: plan.id })).resolves.toMatchObject({ decision: 'aprobado', motivo: null });
      await expect(createAprobacionPlan(db, { planId: plan.id, decision: 'cambios', rolCodigo: 'dueno_cliente' })).resolves.toMatchObject({ decision: 'cambios', motivo: 'ideas' });
      await expect(createAprobacionPlan(db, { planId: plan.id, decision: 'rechazado' })).resolves.toMatchObject({ decision: 'rechazado' });
    });
  });

  it('refuses NovaCiel staff, with or without a client role, and other roles', async () => {
    await withTestTransaction(async (db) => {
      const { plan } = await proposedPlan(db);
      const staff = await createUsuarioConRol(db, 'administrador_novaciel');
      await expectFails(db, /client level needs the role/, () => createAprobacionPlan(db, { planId: plan.id, usuarioId: staff.id, rolCodigo: 'administrador_novaciel' }));
      await assignRole(db, { usuarioId: staff.id, rolCodigo: 'aprobador_cliente', clienteId: plan.cliente_id });
      await expectFails(db, /NovaCiel staff cannot record the client level/, () => createAprobacionPlan(db, { planId: plan.id, usuarioId: staff.id, rolCodigo: 'aprobador_cliente' }));
      const colab = await createUsuarioConRol(db, 'colaborador_cliente', plan.cliente_id);
      await expectFails(db, /client level needs the role/, () => createAprobacionPlan(db, { planId: plan.id, usuarioId: colab.id, rolCodigo: 'colaborador_cliente' }));
    });
  });

  it("refuses another client's approver", async () => {
    await withTestTransaction(async (db) => {
      const { plan } = await proposedPlan(db);
      const other = await createCliente(db);
      const foreign = await createUsuarioConRol(db, 'dueno_cliente', other.id);
      await expectFails(db, /does not hold that approval role for this client/, () => createAprobacionPlan(db, { planId: plan.id, usuarioId: foreign.id, rolCodigo: 'dueno_cliente' }));
    });
  });

  it('refuses a plan that is not proposed', async () => {
    await withTestTransaction(async (db) => {
      for (const estado of ['borrador', 'aprobado', 'descartado'] as const) {
        const plan = await createPlanSemanal(db, { estado });
        await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id });
        await expectFails(db, /only a proposed plan/, () => createAprobacionPlan(db, { planId: plan.id }));
      }
    });
  });

  it('refuses a stale fingerprint: the plan changed while the approver was looking', async () => {
    await withTestTransaction(async (db) => {
      const { plan } = await proposedPlan(db);
      const shown = await planHuella(db, plan.id, plan.cliente_id);
      await createPieza(db, { clienteId: plan.cliente_id, planId: plan.id, idea: 'Idea nueva ficticia' });
      expect(await planHuella(db, plan.id, plan.cliente_id)).not.toEqual(shown);
      await expectFails(db, /fingerprint mismatch/, () => createAprobacionPlan(db, { planId: plan.id, huellaPlan: shown }));
      await expect(createAprobacionPlan(db, { planId: plan.id })).resolves.toMatchObject({ decision: 'aprobado' });
    });
  });

  it('an approval has no reason, a change request or rejection has one', async () => {
    await withTestTransaction(async (db) => {
      const { plan } = await proposedPlan(db);
      await expectFails(db, /check/i, () => createAprobacionPlan(db, { planId: plan.id, motivo: 'ideas' }));
      await expectFails(db, /check/i, () => createAprobacionPlan(db, { planId: plan.id, decision: 'cambios', motivo: null }));
    });
  });
});

describe('aprobadores_cliente: main approver and substitute', () => {
  it('accepts active approvers of the client, and the substitute is optional', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const principal = await createUsuarioConRol(db, 'aprobador_cliente', cliente.id);
      const suplente = await createUsuarioConRol(db, 'dueno_cliente', cliente.id);
      await expect(createAprobadoresCliente(db, { clienteId: cliente.id, principalUsuarioId: principal.id, suplenteUsuarioId: suplente.id })).resolves.toMatchObject({
        principal_usuario_id: principal.id,
        suplente_usuario_id: suplente.id,
      });
      const solo = await createCliente(db);
      await expect(createAprobadoresCliente(db, { clienteId: solo.id })).resolves.toMatchObject({ suplente_usuario_id: null });
    });
  });

  it('refuses NovaCiel staff, another client\'s user, colaborador_cliente, an inactive user, and the same person twice', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const other = await createCliente(db);
      const good = await createUsuarioConRol(db, 'aprobador_cliente', cliente.id);
      const staff = await createUsuarioConRol(db, 'operador_novaciel');
      const staffWithClientRole = await createUsuarioConRol(db, 'operador_novaciel');
      await assignRole(db, { usuarioId: staffWithClientRole.id, rolCodigo: 'aprobador_cliente', clienteId: cliente.id });
      const foreign = await createUsuarioConRol(db, 'aprobador_cliente', other.id);
      const colab = await createUsuarioConRol(db, 'colaborador_cliente', cliente.id);
      const inactive = await createUsuarioConRol(db, 'aprobador_cliente', cliente.id);
      await db.query('UPDATE usuarios SET activo = false WHERE id = $1', [inactive.id]);
      const message = /must be active users with an approval role/;
      for (const bad of [staff, staffWithClientRole, foreign, colab, inactive]) {
        await expectFails(db, message, () => createAprobadoresCliente(db, { clienteId: cliente.id, principalUsuarioId: bad.id }));
        await expectFails(db, message, () => createAprobadoresCliente(db, { clienteId: cliente.id, principalUsuarioId: good.id, suplenteUsuarioId: bad.id }));
      }
      await expectFails(db, /check/i, () => createAprobadoresCliente(db, { clienteId: cliente.id, principalUsuarioId: good.id, suplenteUsuarioId: good.id }));
    });
  });

  it('refuses an update that moves the row to another client or names a foreign approver', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const other = await createCliente(db);
      const mine = await createAprobadoresCliente(db, { clienteId: cliente.id });
      const foreign = await createUsuarioConRol(db, 'aprobador_cliente', other.id);
      await expectFails(db, /the client cannot change/, () => db.query('UPDATE aprobadores_cliente SET cliente_id = $2 WHERE cliente_id = $1', [cliente.id, other.id]));
      await expectFails(db, /must be active users/, () => db.query('UPDATE aprobadores_cliente SET suplente_usuario_id = $2 WHERE cliente_id = $1', [mine.cliente_id, foreign.id]));
    });
  });
});

describe('transitions out of aprobada and programada (ADR-05)', () => {
  const FROM = ['aprobada', 'programada'] as const;

  it('NovaCiel and the system can send an approved or scheduled piece back to con_cambios', async () => {
    await withTestTransaction(async (db) => {
      const staff = await createUsuarioConRol(db, 'operador_novaciel');
      for (const desde of FROM) {
        const byStaff = await createAprobableWorld(db, { estado: desde });
        await moverPieza(db, byStaff.piezaId, 'con_cambios', { actor: { tipo: 'usuario', usuarioId: staff.id } });
        const bySystem = await createAprobableWorld(db, { estado: desde });
        await moverPieza(db, bySystem.piezaId, 'con_cambios', { actor: { tipo: 'sistema' } });
        const { rows } = await db.query('SELECT estado FROM piezas WHERE id = ANY($1)', [[byStaff.piezaId, bySystem.piezaId]]);
        expect(rows.map((r) => r.estado)).toEqual(['con_cambios', 'con_cambios']);
      }
    });
  });

  it('a client user (approver, owner or collaborator) cannot do it, even if the service had a bug', async () => {
    await withTestTransaction(async (db) => {
      for (const desde of FROM) {
        const w = await createAprobableWorld(db, { estado: desde });
        for (const rolCodigo of ['aprobador_cliente', 'dueno_cliente', 'colaborador_cliente']) {
          const client = await createUsuarioConRol(db, rolCodigo, w.clienteId);
          const version = (await db.query<{ v: number }>('SELECT version_estado AS v FROM piezas WHERE id = $1', [w.piezaId])).rows[0]!.v;
          await expectFails(db, /only NovaCiel can move/, () =>
            insertHistorial(db, w.piezaId, w.clienteId, { version: version + 1, desde, hacia: 'con_cambios', actor: { tipo: 'usuario', usuarioId: client.id } }),
          );
        }
      }
    });
  });

  it('other states still cannot go straight to con_cambios', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db, { estado: 'en_control_calidad' });
      const version = (await db.query<{ v: number }>('SELECT version_estado AS v FROM piezas WHERE id = $1', [w.piezaId])).rows[0]!.v;
      await expectFails(db, /not an allowed transition/, () =>
        insertHistorial(db, w.piezaId, w.clienteId, { version: version + 1, desde: 'en_control_calidad', hacia: 'con_cambios', actor: { tipo: 'sistema' } }),
      );
    });
  });
});
