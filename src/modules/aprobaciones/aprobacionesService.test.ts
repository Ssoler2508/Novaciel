import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import {
  assignRole,
  createActores,
  createCliente,
  createPiezaAprobable,
  createProduccion,
  createUsuarioConRol,
  type PiezaAprobable,
} from '../../../tests/utils/factories/index.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import type { Db } from '../../db/types.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { PiezaNotFoundError, InvalidTransitionError } from '../piezas/errors.js';
import { getHistorial, getPieza } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { asClienteId } from '../shared/clienteId.js';
import { listRegistros } from './aprobacionesRepository.js';
import { MOTIVO_PUENTE_PASO_8, reabrirPieza, registrarDecision } from './aprobacionesService.js';
import {
  AprobacionInvalidaError,
  HashDesactualizadoError,
  PermisoDenegadoError,
  PiezaEstadoNoDecidibleError,
} from './errors.js';

const COMENTARIO = 'Comentario ficticio del cliente: cambien el texto de la segunda diapositiva';

async function world(db: Db) {
  const w = await createPiezaAprobable(db, new FakeStorage());
  const actores = await createActores(db, w.clienteId);
  return { w, actores, clienteId: asClienteId(w.clienteId) };
}

const estadoDe = async (db: Db, clienteId: ReturnType<typeof asClienteId>, piezaId: string) => (await getPieza(db, clienteId, piezaId))!.estado;
const nRegistros = async (db: Db, clienteId: ReturnType<typeof asClienteId>, piezaId: string) => (await listRegistros(db, clienteId, piezaId)).length;

describe('registrarDecision: the internal level', () => {
  it('an internal approval from en_control_calidad performs the TEMPORARY Step 8 bridge and leaves the piece waiting for the client', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await world(db);
      const result = await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
      expect(result.pieza.estado).toBe('esperando_aprobacion');
      expect(result.estadoAprobacion).toMatchObject({ estado: 'pendiente_cliente' });
      expect(result.aprobacion).toMatchObject({ nivel: 'interno', decision: 'aprobada', produccionId: w.produccionId, version: 1 });
      const history = (await getHistorial(db, clienteId, w.piezaId)).slice(-2);
      expect(history.map((h) => [h.desde, h.hacia, h.motivo])).toEqual([
        ['en_control_calidad', 'revision_novaciel', MOTIVO_PUENTE_PASO_8],
        ['revision_novaciel', 'esperando_aprobacion', 'aprobacion_interna'],
      ]);
      expect(history.every((h) => h.actor_usuario_id === actores.ids.novaciel)).toBe(true);
    });
  });

  it('from revision_novaciel (once Step 8 exists) it does only the second step', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await world(db);
      await transitionPieza(db, clienteId, w.piezaId, 'revision_novaciel', { tipo: 'sistema' });
      const result = await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
      expect(result.pieza.estado).toBe('esperando_aprobacion');
      expect((await getHistorial(db, clienteId, w.piezaId)).slice(-1).map((h) => h.desde)).toEqual(['revision_novaciel']);
    });
  });

  it('an internal change request sends the piece back to en_produccion and is not a change round', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await world(db);
      const result = await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, {
        nivel: 'interno', decision: 'cambios', hashVisto: w.hashHex, motivo: 'texto', comentario: COMENTARIO,
      });
      expect(result.pieza.estado).toBe('en_produccion');
      expect(result.escalada).toEqual({ rondas: 0, escalada: false, notificarAhora: false });
      expect(result.estadoAprobacion).toMatchObject({ estado: 'cambios_pedidos', ronda: 0 });
    });
  });

  it('refuses a rejection at the internal level and a change request without a reason', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await world(db);
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'rechazada', hashVisto: w.hashHex, motivo: 'otro' }),
      ).rejects.toBeInstanceOf(AprobacionInvalidaError);
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'cambios', hashVisto: w.hashHex }),
      ).rejects.toBeInstanceOf(AprobacionInvalidaError);
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: 'no-es-un-hash' }),
      ).rejects.toBeInstanceOf(AprobacionInvalidaError);
      expect(await nRegistros(db, clienteId, w.piezaId)).toBe(0);
      expect(await estadoDe(db, clienteId, w.piezaId)).toBe('en_control_calidad');
    });
  });
});

describe('registrarDecision: the client level', () => {
  async function waitingForClient(db: Db) {
    const x = await world(db);
    await registrarDecision({ db }, x.clienteId, x.w.piezaId, x.actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: x.w.hashHex });
    return x;
  }

  it('approves, asks for changes (a round) or rejects, and moves the piece', async () => {
    await withTestTransaction(async (db) => {
      const a = await waitingForClient(db);
      const approved = await registrarDecision({ db }, a.clienteId, a.w.piezaId, a.actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: a.w.hashHex, dispositivo: 'movil · Safari' });
      expect(approved.pieza.estado).toBe('aprobada');
      expect(approved.estadoAprobacion).toMatchObject({ estado: 'aprobada' });

      const b = await waitingForClient(db);
      const changes = await registrarDecision({ db }, b.clienteId, b.w.piezaId, b.actores.cliente, {
        nivel: 'cliente', decision: 'cambios', hashVisto: b.w.hashHex, motivo: 'gancho', segundoMs: 4200, comentario: COMENTARIO,
      });
      expect(changes.pieza.estado).toBe('con_cambios');
      expect(changes.estadoAprobacion).toMatchObject({ estado: 'cambios_pedidos', ronda: 1 });
      expect(changes.escalada).toEqual({ rondas: 1, escalada: false, notificarAhora: false });

      const c = await waitingForClient(db);
      const rejected = await registrarDecision({ db }, c.clienteId, c.w.piezaId, c.actores.cliente, { nivel: 'cliente', decision: 'rechazada', hashVisto: c.w.hashHex, motivo: 'otro' });
      expect(rejected.pieza.estado).toBe('rechazada');
      expect(rejected.estadoAprobacion).toEqual({ estado: 'rechazada' });
    });
  });

  it('the audit row has ids, level, decision and hash, and never the comment; the comment is stored', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await waitingForClient(db);
      const result = await registrarDecision({ db }, clienteId, w.piezaId, actores.cliente, {
        nivel: 'cliente', decision: 'cambios', hashVisto: w.hashHex, motivo: 'texto', comentario: COMENTARIO,
      });
      const rows = (await auditRowsFor(db, 'aprobaciones', result.aprobacion.id)).filter((r) => r.accion === 'decidir');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        cliente_id: w.clienteId,
        actor_tipo: 'usuario',
        datos_despues: { nivel: 'cliente', decision: 'cambios', hash_pieza: w.hashHex, produccion_id: w.produccionId, version: 1, rol: 'aprobador_cliente' },
      });
      expect(JSON.stringify(rows)).not.toContain('cambien el texto');
      const stored = await db.query('SELECT comentario FROM aprobaciones WHERE id = $1', [result.aprobacion.id]);
      expect(stored.rows[0]!.comentario).toBe(COMENTARIO);
    });
  });

  it('a client cannot decide before the piece waits for them, and a decided piece cannot be decided again', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await world(db);
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex }),
      ).rejects.toBeInstanceOf(PiezaEstadoNoDecidibleError);
      await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
      await registrarDecision({ db }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex });
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'cambios', hashVisto: w.hashHex, motivo: 'texto' }),
      ).rejects.toBeInstanceOf(PiezaEstadoNoDecidibleError);
    });
  });
});

describe('registrarDecision: who may decide', () => {
  it('refuses the wrong level for each role, with nothing written', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await world(db);
      const dueno = { usuarioId: (await createUsuarioConRol(db, 'dueno_cliente', w.clienteId)).id, roles: [{ rol: 'dueno_cliente', clienteId }] };
      const colaborador = { usuarioId: (await createUsuarioConRol(db, 'colaborador_cliente', w.clienteId)).id, roles: [{ rol: 'colaborador_cliente', clienteId }] };
      const otherClient = asClienteId((await createCliente(db)).id);
      const foreign = { usuarioId: (await createUsuarioConRol(db, 'aprobador_cliente', otherClient)).id, roles: [{ rol: 'aprobador_cliente', clienteId: otherClient }] };
      const interno = { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex } as const;
      for (const actor of [actores.cliente, dueno, colaborador, foreign]) {
        await expect(registrarDecision({ db }, clienteId, w.piezaId, actor, interno)).rejects.toBeInstanceOf(PermisoDenegadoError);
      }
      await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, interno);
      const cliente = { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex } as const;
      for (const actor of [actores.novaciel, colaborador, foreign]) {
        await expect(registrarDecision({ db }, clienteId, w.piezaId, actor, cliente)).rejects.toBeInstanceOf(PermisoDenegadoError);
      }
      expect(await nRegistros(db, clienteId, w.piezaId)).toBe(1);
      expect(await estadoDe(db, clienteId, w.piezaId)).toBe('esperando_aprobacion');
    });
  });

  it('NovaCiel staff can never record the client level, not even holding a client role for that client', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await world(db);
      await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
      await assignRole(db, { usuarioId: actores.ids.novaciel, rolCodigo: 'aprobador_cliente', clienteId: w.clienteId });
      const both = { usuarioId: actores.ids.novaciel, roles: [...actores.novaciel.roles, { rol: 'aprobador_cliente', clienteId }] };
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, both, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex }),
      ).rejects.toBeInstanceOf(PermisoDenegadoError);
      expect(await estadoDe(db, clienteId, w.piezaId)).toBe('esperando_aprobacion');
    });
  });

  it("a piece of another client is not found, even for a valid approver of that other client", async () => {
    await withTestTransaction(async (db) => {
      const { w } = await world(db);
      const other = await world(db);
      await expect(
        registrarDecision({ db }, other.clienteId, w.piezaId, other.actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex }),
      ).rejects.toBeInstanceOf(PiezaNotFoundError);
    });
  });
});

describe('registrarDecision: the approver confirms what they saw', () => {
  it('refuses a stale hash (nothing written, state unchanged) and accepts the current one', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await world(db);
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: 'f'.repeat(64) }),
      ).rejects.toBeInstanceOf(HashDesactualizadoError);
      expect(await nRegistros(db, clienteId, w.piezaId)).toBe(0);
      expect(await estadoDe(db, clienteId, w.piezaId)).toBe('en_control_calidad');
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex }),
      ).resolves.toMatchObject({ pieza: { estado: 'esperando_aprobacion' } });
    });
  });

  it('after a new production version the old hash is stale', async () => {
    await withTestTransaction(async (db) => {
      const { w, actores, clienteId } = await world(db);
      await createProduccion(db, { piezaId: w.piezaId });
      await expect(
        registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex }),
      ).rejects.toBeInstanceOf(HashDesactualizadoError);
    });
  });
});

describe('change rounds and escalation', () => {
  /** One full round: internal approval, client change request, NovaCiel takes it back and produces a new version. */
  async function round(db: Db, x: { w: PiezaAprobable; actores: Awaited<ReturnType<typeof createActores>>; clienteId: ReturnType<typeof asClienteId> }, hash: string) {
    await registrarDecision({ db }, x.clienteId, x.w.piezaId, x.actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: hash });
    return registrarDecision({ db }, x.clienteId, x.w.piezaId, x.actores.cliente, { nivel: 'cliente', decision: 'cambios', hashVisto: hash, motivo: 'texto' });
  }

  it('the 3rd client change request escalates and asks to notify exactly once; internal requests never count', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      // An internal change request first: it does not count.
      await registrarDecision({ db }, x.clienteId, x.w.piezaId, x.actores.novaciel, { nivel: 'interno', decision: 'cambios', hashVisto: x.w.hashHex, motivo: 'toma' });
      await createProduccion(db, { piezaId: x.w.piezaId });
      await transitionPieza(db, x.clienteId, x.w.piezaId, 'en_control_calidad', { tipo: 'sistema' });

      const flags = [];
      for (let i = 0; i < 4; i++) {
        const hash = (await db.query<{ h: string }>(`SELECT encode(hash_pieza, 'hex') AS h FROM producciones WHERE pieza_id = $1 AND es_actual`, [x.w.piezaId])).rows[0]!.h;
        flags.push((await round(db, x, hash)).escalada);
        await transitionPieza(db, x.clienteId, x.w.piezaId, 'en_produccion', { tipo: 'sistema' });
        await createProduccion(db, { piezaId: x.w.piezaId });
        await transitionPieza(db, x.clienteId, x.w.piezaId, 'en_control_calidad', { tipo: 'sistema' });
      }
      expect(flags).toEqual([
        { rondas: 1, escalada: false, notificarAhora: false },
        { rondas: 2, escalada: false, notificarAhora: false },
        { rondas: 3, escalada: true, notificarAhora: true },
        { rondas: 4, escalada: true, notificarAhora: false },
      ]);
    });
  });
});

describe('reabrirPieza (aprobada or programada back to con_cambios)', () => {
  async function approved(db: Db) {
    const x = await world(db);
    await registrarDecision({ db }, x.clienteId, x.w.piezaId, x.actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: x.w.hashHex });
    await registrarDecision({ db }, x.clienteId, x.w.piezaId, x.actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: x.w.hashHex });
    return x;
  }

  it('NovaCiel can do it from aprobada and from programada', async () => {
    await withTestTransaction(async (db) => {
      const a = await approved(db);
      expect((await reabrirPieza({ db }, a.clienteId, a.w.piezaId, a.actores.novaciel, 'el cliente cambio de opinion')).estado).toBe('con_cambios');
      const b = await approved(db);
      await transitionPieza(db, b.clienteId, b.w.piezaId, 'programada', { tipo: 'sistema' });
      expect((await reabrirPieza({ db }, b.clienteId, b.w.piezaId, b.actores.novaciel, 'otro cambio')).estado).toBe('con_cambios');
    });
  });

  it('a client user cannot, and a piece in another state cannot', async () => {
    await withTestTransaction(async (db) => {
      const a = await approved(db);
      await expect(reabrirPieza({ db }, a.clienteId, a.w.piezaId, a.actores.cliente, 'x')).rejects.toBeInstanceOf(PermisoDenegadoError);
      expect(await estadoDe(db, a.clienteId, a.w.piezaId)).toBe('aprobada');
      const b = await world(db);
      await expect(reabrirPieza({ db }, b.clienteId, b.w.piezaId, b.actores.novaciel, 'x')).rejects.toBeInstanceOf(InvalidTransitionError);
    });
  });
});
