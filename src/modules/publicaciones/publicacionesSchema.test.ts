import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/types.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import {
  createAprobableWorld,
  createConexionRed,
  createMetricaPieza,
  createPublicacion,
  createPublicacionResultado,
  moverPieza,
} from '../../../tests/utils/factories/index.js';

// The database guarantees of Step 10, checkpoint A: append-only records, no double publication, and the
// binding of an attempt to the exact production. Plain SQL through the factories: the triggers are the subject.

/** Runs `fn` expecting the database to refuse it, and undoes only that statement. */
async function refused(db: Db, fn: () => Promise<unknown>, message?: RegExp): Promise<void> {
  await db.query('SAVEPOINT refused');
  if (message) await expect(fn()).rejects.toThrow(message);
  else await expect(fn()).rejects.toThrow();
  await db.query('ROLLBACK TO SAVEPOINT refused');
}

async function programada(db: Db) {
  const w = await createAprobableWorld(db, { estado: 'programada' });
  return w;
}

describe('publicaciones: append-only', () => {
  it('attempts, results and snapshots cannot be updated or deleted', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      const intento = await createPublicacion(db, { piezaId: w.piezaId });
      const resultado = await createPublicacionResultado(db, { publicacionId: intento.id });
      const metrica = await createMetricaPieza(db, { publicacionId: intento.id });
      for (const [table, id] of [['publicaciones', intento.id], ['publicaciones_resultados', resultado.id], ['metricas_pieza', metrica.id]] as const) {
        await refused(db, () => db.query(`DELETE FROM ${table} WHERE id = $1`, [id]), /append-only/);
      }
      await refused(db, () => db.query('UPDATE publicaciones SET etiqueta_ia = true WHERE id = $1', [intento.id]), /append-only/);
      await refused(db, () => db.query(`UPDATE publicaciones_resultados SET estado = 'fallida' WHERE id = $1`, [resultado.id]), /append-only/);
      await refused(db, () => db.query('UPDATE metricas_pieza SET alcance = 1 WHERE id = $1', [metrica.id]), /append-only/);
    });
  });
});

describe('publicaciones: no double publication', () => {
  it('a second attempt is refused while the first has no result', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      await createPublicacion(db, { piezaId: w.piezaId });
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId }), /previous one to have ended fallida/);
    });
  });

  it('the same attempt number cannot be used twice', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      await createPublicacion(db, { piezaId: w.piezaId });
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId, numeroIntento: 1 }), /duplicate key|consecutive/);
    });
  });

  it('a retry is allowed only after a failed attempt, with the next number and the same key', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      const primero = await createPublicacion(db, { piezaId: w.piezaId });
      await createPublicacionResultado(db, { publicacionId: primero.id, estado: 'fallida', categoriaError: 'rate_limit' });
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId, numeroIntento: 3 }), /consecutive/);
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId, claveIdempotencia: 'otra-clave' }), /same idempotency key/);
      const segundo = await createPublicacion(db, { piezaId: w.piezaId });
      expect(segundo.numero_intento).toBe(2);
      expect(segundo.clave_idempotencia).toBe(primero.clave_idempotencia);
    });
  });

  it('an unknown outcome blocks any new attempt until it is settled; the settling result is the only second result allowed', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      const intento = await createPublicacion(db, { piezaId: w.piezaId });
      await createPublicacionResultado(db, { publicacionId: intento.id, estado: 'desconocida', categoriaError: 'timeout' });
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId }), /previous one to have ended fallida/);
      await refused(db, () => createPublicacionResultado(db, { publicacionId: intento.id, estado: 'desconocida' }), /already has a final result/);
      const resolucion = await createPublicacionResultado(db, { publicacionId: intento.id, estado: 'publicada' });
      expect(resolucion.estado).toBe('publicada');
      await refused(db, () => createPublicacionResultado(db, { publicacionId: intento.id, estado: 'fallida' }), /already has a final result/);
    });
  });

  it('a final result is final: a published attempt takes no other result and no new attempt', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      const intento = await createPublicacion(db, { piezaId: w.piezaId });
      await createPublicacionResultado(db, { publicacionId: intento.id });
      await refused(db, () => createPublicacionResultado(db, { publicacionId: intento.id, estado: 'fallida' }), /already has a final result/);
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId }), /already published|previous one to have ended fallida/);
    });
  });

  it('a piece is published once: the unique indexes on the published result exist (the triggers stop the attempt first)', async () => {
    await withTestTransaction(async (db) => {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_indexes WHERE indexname IN ('publicaciones_resultados_produccion_publicada_key', 'publicaciones_resultados_pieza_publicada_key')`,
      );
      expect(Number(rows[0]!.n)).toBe(2);
    });
  });

  it('result fields must match the state: no id on a failure, no error on a publication', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      const intento = await createPublicacion(db, { piezaId: w.piezaId });
      const insertar = (estado: string, idExterno: string | null, categoria: string | null, enlace: string | null = null) =>
        db.query(
          `INSERT INTO publicaciones_resultados (cliente_id, publicacion_id, pieza_id, produccion_id, estado, id_externo, enlace, categoria_error, actor_tipo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sistema')`,
          [intento.cliente_id, intento.id, intento.pieza_id, intento.produccion_id, estado, idExterno, enlace, categoria],
        );
      await refused(db, () => insertar('publicada', null, null), /check/);
      await refused(db, () => insertar('publicada', 'ext-1', 'server'), /check/);
      await refused(db, () => insertar('fallida', 'ext-1', 'server'), /check/);
      await refused(db, () => insertar('fallida', null, null), /check/);
      // Only a closed category: the provider's message can never be stored.
      await refused(db, () => insertar('fallida', null, 'El proveedor dijo: texto del cliente'), /check/);
      await refused(db, () => insertar('publicada', 'ext-1', null, 'http://insecure.example'), /check/);
    });
  });
});

describe('publicaciones: bound to the exact production', () => {
  it('refuses a different version or a different hash', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId, produccionVersion: 2 }), /exact production/);
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId, hashPieza: Buffer.alloc(32, 1) }), /exact production/);
    });
  });

  it("refuses another piece's production (of the same or of another client)", async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      const otra = await programada(db);
      await refused(db, () => createPublicacion(db, { piezaId: otra.piezaId, produccionId: w.produccionId }), /does not belong to this piece|foreign key/);
    });
  });

  it('refuses a piece that is not programada', async () => {
    await withTestTransaction(async (db) => {
      const w = await createAprobableWorld(db, { estado: 'aprobada' });
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId }), /must be programada/);
    });
  });

  it('refuses a piece that left programada after the attempt was planned (paused)', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      await moverPieza(db, w.piezaId, 'pausada');
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId }), /must be programada/);
    });
  });

  it('needs an active connection of the same client and network', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      const revocada = await createConexionRed(db, { clienteId: w.clienteId, red: 'facebook', revoked: true });
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId, conexionId: revocada.id, red: 'facebook' }), /network is not the one/);
      const otraRed = await createConexionRed(db, { clienteId: w.clienteId, red: 'youtube' });
      await refused(db, () => createPublicacion(db, { piezaId: w.piezaId, conexionId: otraRed.id }), /active one of this client and network/);
    });
  });
});

describe('metricas_pieza', () => {
  it('needs a published result, and a window is collected once', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      const intento = await createPublicacion(db, { piezaId: w.piezaId });
      await refused(db, () => createMetricaPieza(db, { publicacionId: intento.id }), /no published result/);
      await createPublicacionResultado(db, { publicacionId: intento.id });
      const metrica = await createMetricaPieza(db, { publicacionId: intento.id, ventana: '24h', alcance: null });
      expect(metrica.alcance).toBeNull();
      await refused(db, () => createMetricaPieza(db, { publicacionId: intento.id, ventana: '24h' }), /metricas_pieza_publicacion_id_ventana_key/);
      await createMetricaPieza(db, { publicacionId: intento.id, ventana: '72h' });
    });
  });

  it('refuses negative numbers, a retention over 100 and an unknown window', async () => {
    await withTestTransaction(async (db) => {
      const w = await programada(db);
      const intento = await createPublicacion(db, { piezaId: w.piezaId });
      await createPublicacionResultado(db, { publicacionId: intento.id });
      await refused(db, () => createMetricaPieza(db, { publicacionId: intento.id, alcance: -1 }), /check/);
      await refused(db, () => db.query(`INSERT INTO metricas_pieza (cliente_id, publicacion_id, ventana, retencion_pct) VALUES ($1, $2, '24h', 101)`, [intento.cliente_id, intento.id]), /check/);
      await refused(db, () => db.query(`INSERT INTO metricas_pieza (cliente_id, publicacion_id, ventana) VALUES ($1, $2, '1h')`, [intento.cliente_id, intento.id]), /check/);
    });
  });
});
