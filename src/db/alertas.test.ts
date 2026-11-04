import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createAlerta, createAlertaReconocimiento, createCliente, createUsuario } from '../../tests/utils/factories/index.js';
import type { Db } from './types.js';

/** Expects `run` to fail with a message matching `match`, keeping the surrounding transaction usable. */
async function expectFails(db: Db, match: string | RegExp, run: () => Promise<unknown>): Promise<void> {
  await db.query('SAVEPOINT expect_fails');
  await expect(run()).rejects.toThrow(match);
  await db.query('ROLLBACK TO SAVEPOINT expect_fails');
}

describe('alertas: schema (Step 11)', () => {
  it('stores a client alert and a global one (cliente_id NULL)', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const propia = await createAlerta(db, { clienteId: cliente.id, parametros: { umbral: 80, periodo: '2026-11-01' } });
      const global = await createAlerta(db, { codigo: 'trabajo_fallido', parametros: { cola: 'q', jobId: 'j' } });
      expect(propia.cliente_id).toBe(cliente.id);
      expect(global.cliente_id).toBeNull();
      expect(propia.parametros).toEqual({ umbral: 80, periodo: '2026-11-01' });
    });
  });

  it('refuses a bad code, a bad severity, non-object parameters, an empty dedupe key and an unknown client', async () => {
    await withTestTransaction(async (db) => {
      const ins = (codigo: string, severidad: string, parametros: string, clave: string, cliente: string | null = null) =>
        db.query('INSERT INTO alertas (cliente_id, codigo, severidad, parametros, clave_dedupe) VALUES ($1, $2, $3, $4::jsonb, $5)', [cliente, codigo, severidad, parametros, clave]);
      await expectFails(db, /check/i, () => ins('Bad-Code', 'aviso', '{}', 'k1'));
      await expectFails(db, /check/i, () => ins('ok_code', 'grave', '{}', 'k2'));
      await expectFails(db, /check/i, () => ins('ok_code', 'aviso', '[1]', 'k3'));
      await expectFails(db, /check/i, () => ins('ok_code', 'aviso', '{}', '  '));
      await expectFails(db, /foreign key|for[aá]nea/i, () => ins('ok_code', 'aviso', '{}', 'k5', '00000000-0000-4000-8000-000000000000'));
    });
  });

  it('the dedupe key is unique: the same key twice conflicts, ON CONFLICT DO NOTHING inserts nothing', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const clave = `presupuesto:${cliente.id}:2026-11-01:80`;
      await createAlerta(db, { clienteId: cliente.id, claveDedupe: clave });
      await expectFails(db, /unique|duplic/i, () => createAlerta(db, { clienteId: cliente.id, claveDedupe: clave }));
      const again = await db.query(
        `INSERT INTO alertas (cliente_id, codigo, severidad, clave_dedupe) VALUES ($1, 'presupuesto_umbral_80', 'aviso', $2)
         ON CONFLICT (clave_dedupe) DO NOTHING RETURNING id`,
        [cliente.id, clave],
      );
      expect(again.rows).toHaveLength(0);
      // The next month has another key, so it is a new alert.
      await createAlerta(db, { clienteId: cliente.id, claveDedupe: `presupuesto:${cliente.id}:2026-12-01:80` });
    });
  });
});

describe('alertas: append-only and acknowledgement (Step 11)', () => {
  it('refuses UPDATE, DELETE and TRUNCATE of alerts, also outside the test cleanup flag', async () => {
    await withTestTransaction(async (db) => {
      const a = await createAlerta(db, { clienteId: (await createCliente(db)).id });
      await expectFails(db, /append-only/, () => db.query("UPDATE alertas SET severidad = 'critica' WHERE id = $1", [a.id]));
      await expectFails(db, /append-only/, () => db.query('DELETE FROM alertas WHERE id = $1', [a.id]));
      await expectFails(db, /append-only/, () => db.query('TRUNCATE alertas CASCADE'));
      expect((await db.query('SELECT 1 FROM alertas WHERE id = $1', [a.id])).rows).toHaveLength(1);
    });
  });

  it('an alert is acknowledged once, with who and when; the record is append-only', async () => {
    await withTestTransaction(async (db) => {
      const a = await createAlerta(db, { clienteId: (await createCliente(db)).id });
      const user = await createUsuario(db);
      const ack = await createAlertaReconocimiento(db, { alertaId: a.id, usuarioId: user.id });
      expect(ack.usuario_id).toBe(user.id);
      expect(ack.cliente_id).toBe(a.cliente_id);
      expect(ack.reconocido_en).toBeInstanceOf(Date);
      await expectFails(db, /unique|duplic|primary/i, () => createAlertaReconocimiento(db, { alertaId: a.id }));
      await expectFails(db, /append-only/, () => db.query('UPDATE alertas_reconocimientos SET usuario_id = $2 WHERE alerta_id = $1', [a.id, user.id]));
      await expectFails(db, /append-only/, () => db.query('DELETE FROM alertas_reconocimientos WHERE alerta_id = $1', [a.id]));
      await expectFails(db, /append-only/, () => db.query('TRUNCATE alertas_reconocimientos'));
    });
  });

  it('an acknowledgement cannot carry another client id than its alert', async () => {
    await withTestTransaction(async (db) => {
      const a = await createAlerta(db, { clienteId: (await createCliente(db)).id });
      const otro = await createCliente(db);
      const user = await createUsuario(db);
      await expectFails(db, /foreign key|for[aá]nea/i, () =>
        db.query('INSERT INTO alertas_reconocimientos (alerta_id, cliente_id, usuario_id) VALUES ($1, $2, $3)', [a.id, otro.id, user.id]),
      );
    });
  });

  it('a global alert can be acknowledged too (cliente_id stays NULL)', async () => {
    await withTestTransaction(async (db) => {
      const g = await createAlerta(db, { codigo: 'interruptor_global_apagado', severidad: 'critica' });
      const ack = await createAlertaReconocimiento(db, { alertaId: g.id });
      expect(ack.cliente_id).toBeNull();
    });
  });
});
