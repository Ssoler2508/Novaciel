import type { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { createCliente, createGuion, createMedia, createPerfilMarca, createPieza, createPlanSemanal, moverPieza } from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { getPieza } from '../piezas/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { producirPieza } from './produccionService.js';

// With the REAL pool, so the service opens a real transaction, and a pool whose COMMIT fails: the
// stored files must be deleted and nothing may stay (the transaction is rolled back).
// The data is committed with the factories (plain SQL, no audit rows) and removed afterwards.

/** A pool that behaves like the real one, except that COMMIT fails. instanceof Pool still holds. */
function poolWithFailingCommit(pool: Pool): Db {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, p) {
              if (p === 'query') {
                return (sql: unknown, ...rest: unknown[]) =>
                  sql === 'COMMIT' ? Promise.reject(new Error('commit failed')) : (c.query as (...args: unknown[]) => unknown)(sql, ...rest);
              }
              const value = Reflect.get(c, p, c);
              return typeof value === 'function' ? value.bind(c) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Db;
}

describe('producirPieza: a COMMIT that fails', () => {
  afterAll(async () => {
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  it('deletes the stored files, keeps no row, and leaves the piece where it was', async () => {
    const pool = getTestPool();
    await cleanupDomainTables(pool);
    const cliente = await createCliente(pool);
    const clienteId = asClienteId(cliente.id);
    const perfil = await createPerfilMarca(pool, { clienteId });
    const plan = await createPlanSemanal(pool, { clienteId, estado: 'aprobado', perfilMarcaId: perfil.id });
    const pieza = await createPieza(pool, { clienteId, planId: plan.id, estado: 'plan_aprobado', formato: 'post' });
    const storage = new FakeStorage();
    const media = await createMedia(pool, { clienteId, tipo: 'foto', ancho: 1600, alto: 1200 });
    await storage.put(media.clave_almacenamiento, await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#336699' } }).jpeg().toBuffer());
    await createGuion(pool, {
      piezaId: pieza.id,
      perfilMarcaId: perfil.id,
      tomas: [{ mediaId: media.id }],
      contenido: {
        formato: 'post',
        gancho: 'Hola',
        escenas: [{ orden: 1, texto_en_pantalla: 'Hola mundo', texto_alternativo: 'Una foto', toma: { media_id: media.id } }],
        texto_publicacion: { texto: 'Texto', hashtags: ['#a'] },
        llamado_a_accion: 'Escríbenos',
        notas_produccion: 'Luz natural',
        hechos_omitidos: [],
      },
    });
    await moverPieza(pool, pieza.id, 'guion_listo');
    const antes = await storage.keys().length;

    await expect(producirPieza({ db: poolWithFailingCommit(pool), storage }, clienteId, pieza.id, { tipo: 'sistema' })).rejects.toThrow('commit failed');

    expect(storage.keys().filter((key) => key.includes('/producidos/'))).toEqual([]);
    expect(storage.keys()).toHaveLength(antes);
    expect(Number((await pool.query('SELECT count(*) AS n FROM producciones WHERE cliente_id = $1', [clienteId])).rows[0].n)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) AS n FROM producciones_archivos WHERE cliente_id = $1', [clienteId])).rows[0].n)).toBe(0);
    expect((await getPieza(pool, clienteId, pieza.id))!.estado).toBe('guion_listo');
    expect(Number((await pool.query(`SELECT count(*) AS n FROM auditoria WHERE cliente_id = $1 AND tabla IN ('producciones')`, [clienteId])).rows[0].n)).toBe(0);
  }, 60_000);
});
