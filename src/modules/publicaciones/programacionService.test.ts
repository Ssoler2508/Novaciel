import { describe, expect, it } from 'vitest';
import { createPiezaProgramada } from '../../../tests/utils/publicacionWorld.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import {
  createActores,
  createPerfilMarca,
  createPiezaAprobable,
  createPublicacion,
  moverPieza,
} from '../../../tests/utils/factories/index.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { ArchivoAlteradoError, SinAprobacionVigenteError } from '../aprobaciones/errors.js';
import { registrarDecision } from '../aprobaciones/aprobacionesService.js';
import { FakeRecordatorios } from '../aprobaciones/recordatoriosPort.js';
import { PiezaNotFoundError } from '../piezas/errors.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { asClienteId } from '../shared/clienteId.js';
import { PiezaEstadoProgramacionError, ProgramacionInvalidaError, PublicacionAbiertaError } from './errors.js';
import { programarPieza, reprogramarPieza } from './programacionService.js';

const DIA = 86_400_000;
const sistema = { tipo: 'sistema' } as const;

async function aprobada(db: Parameters<typeof createPiezaAprobable>[0]) {
  const storage = new FakeStorage();
  const w = await createPiezaAprobable(db, storage);
  const actores = await createActores(db, w.clienteId);
  const clienteId = asClienteId(w.clienteId);
  await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
  await registrarDecision({ db }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex });
  return { w, clienteId, storage, actores };
}

describe('programarPieza', () => {
  it('moves an approved piece to programada, saves the time, audits and queues the reminders for the new deadline', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      const recordatorios = new FakeRecordatorios();
      const cuando = new Date(Date.now() + 3 * DIA);
      const pieza = await programarPieza({ db, storage: x.storage, recordatorios }, x.clienteId, x.w.piezaId, cuando, { tipo: 'usuario', usuarioId: x.actores.ids.novaciel });
      expect(pieza.estado).toBe('programada');
      expect(pieza.fecha_hora.getTime()).toBe(cuando.getTime());
      expect(recordatorios.programados).toHaveLength(1);
      expect(recordatorios.programados[0]!.input).toMatchObject({ tipo: 'pieza', objetoId: x.w.piezaId, referencia: x.w.hashHex });
      expect(recordatorios.programados[0]!.input.plazo.getTime()).toBe(cuando.getTime());
      const { rows } = await db.query(`SELECT datos_despues FROM auditoria WHERE accion = 'programar_pieza' AND fila_id = $1`, [x.w.piezaId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].datos_despues.fecha_hora).toBe(cuando.toISOString());
    });
  });

  it('refuses a time in the past and a vetoed hour, and the piece stays aprobada', async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      await expect(programarPieza({ db, storage: x.storage }, x.clienteId, x.w.piezaId, new Date(Date.now() - 60_000), sistema)).rejects.toMatchObject({
        name: 'ProgramacionInvalidaError',
        motivos: ['fecha_pasada'],
      });
      expect((await getPieza(db, x.clienteId, x.w.piezaId))!.estado).toBe('aprobada');
      // Every hour of every day is vetoed: whatever the time, it is refused.
      await db.query('UPDATE perfil_marca SET es_actual = false WHERE cliente_id = $1 AND es_actual', [x.clienteId]);
      await createPerfilMarca(db, { clienteId: x.clienteId, operacion: { horarios_vetados: [{ desde: '00:00', hasta: '23:59' }] } });
      // On the hour: local minutes are 00, 15, 30 or 45, never the one free minute (23:59).
      const enPunto = new Date(Math.floor((Date.now() + 2 * DIA) / 3_600_000) * 3_600_000);
      const error = await programarPieza({ db, storage: x.storage }, x.clienteId, x.w.piezaId, enPunto, sistema).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProgramacionInvalidaError);
      expect((error as ProgramacionInvalidaError).motivos).toContain('horario_vetado');
    });
  });

  it('refuses a piece that is not approved, and a piece whose stored file changed', async () => {
    await withTestTransaction(async (db) => {
      const storage = new FakeStorage();
      const w = await createPiezaAprobable(db, storage);
      const clienteId = asClienteId(w.clienteId);
      await expect(programarPieza({ db, storage }, clienteId, w.piezaId, new Date(Date.now() + DIA), sistema)).rejects.toBeInstanceOf(PiezaEstadoProgramacionError);

      const x = await aprobada(db);
      await x.storage.put(x.w.claves[0]!, Buffer.from('otro contenido'), 'image/jpeg');
      await expect(programarPieza({ db, storage: x.storage }, x.clienteId, x.w.piezaId, new Date(Date.now() + DIA), sistema)).rejects.toBeInstanceOf(ArchivoAlteradoError);
      expect((await getPieza(db, x.clienteId, x.w.piezaId))!.estado).toBe('aprobada');
    });
  });

  it("does not see another client's piece", async () => {
    await withTestTransaction(async (db) => {
      const x = await aprobada(db);
      const otro = await aprobada(db);
      await expect(programarPieza({ db, storage: x.storage }, otro.clienteId, x.w.piezaId, new Date(Date.now() + DIA), sistema)).rejects.toBeInstanceOf(PiezaNotFoundError);
    });
  });
});

describe('reprogramarPieza', () => {
  it('moves the time, keeps the approvals and queues the reminders again', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const recordatorios = new FakeRecordatorios();
      const nuevo = new Date(Date.now() + 5 * DIA);
      const pieza = await reprogramarPieza({ db, storage: p.storage, recordatorios }, p.clienteId, p.w.piezaId, nuevo, sistema);
      expect(pieza.estado).toBe('programada');
      expect(pieza.fecha_hora.getTime()).toBe(nuevo.getTime());
      expect(recordatorios.programados).toHaveLength(1);
      expect(recordatorios.programados[0]!.input.plazo.getTime()).toBe(nuevo.getTime());
      // The approvals of the exact files still stand (fecha_hora is not part of np1).
      const { rows } = await db.query(`SELECT 1 FROM auditoria WHERE accion = 'reprogramar_pieza' AND fila_id = $1`, [p.w.piezaId]);
      expect(rows).toHaveLength(1);
      await expect(programarPieza({ db, storage: p.storage }, p.clienteId, p.w.piezaId, nuevo, sistema)).rejects.toBeInstanceOf(PiezaEstadoProgramacionError);
    });
  });

  it('refuses a time in the past and a piece that is not programada', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await expect(reprogramarPieza({ db, storage: p.storage }, p.clienteId, p.w.piezaId, new Date(Date.now() - 1000), sistema)).rejects.toBeInstanceOf(ProgramacionInvalidaError);
      const x = await aprobada(db);
      await expect(reprogramarPieza({ db, storage: x.storage }, x.clienteId, x.w.piezaId, new Date(Date.now() + DIA), sistema)).rejects.toBeInstanceOf(PiezaEstadoProgramacionError);
    });
  });

  it('refuses while an attempt is still open (no result yet)', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await createPublicacion(db, { piezaId: p.w.piezaId });
      await expect(reprogramarPieza({ db, storage: p.storage }, p.clienteId, p.w.piezaId, new Date(Date.now() + DIA), sistema)).rejects.toBeInstanceOf(PublicacionAbiertaError);
    });
  });
});

describe('the manual retry: fallo_publicacion -> programada', () => {
  it('goes through the same rules: future time, gate, audit', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await transitionPieza(db, p.clienteId, p.w.piezaId, 'fallo_publicacion', sistema, { motivo: 'prueba' });
      const recordatorios = new FakeRecordatorios();
      await expect(programarPieza({ db, storage: p.storage, recordatorios }, p.clienteId, p.w.piezaId, new Date(Date.now() - 1000), sistema)).rejects.toBeInstanceOf(ProgramacionInvalidaError);
      expect((await getPieza(db, p.clienteId, p.w.piezaId))!.estado).toBe('fallo_publicacion');

      const cuando = new Date(Date.now() + DIA);
      const pieza = await programarPieza({ db, storage: p.storage, recordatorios }, p.clienteId, p.w.piezaId, cuando, { tipo: 'usuario', usuarioId: p.actores.ids.novaciel });
      expect(pieza.estado).toBe('programada');
      expect(recordatorios.programados).toHaveLength(1);
      // The first schedule (done by the helper) and the retry.
      const { rows } = await db.query(`SELECT 1 FROM auditoria WHERE accion = 'programar_pieza' AND fila_id = $1`, [p.w.piezaId]);
      expect(rows).toHaveLength(2);
    });
  });

  it('is refused when the gate fails (a stored file changed)', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await transitionPieza(db, p.clienteId, p.w.piezaId, 'fallo_publicacion', sistema, { motivo: 'prueba' });
      await p.storage.put(p.w.claves[1]!, Buffer.from('alterado'), 'image/jpeg');
      await expect(programarPieza({ db, storage: p.storage }, p.clienteId, p.w.piezaId, new Date(Date.now() + DIA), sistema)).rejects.toBeInstanceOf(ArchivoAlteradoError);
    });
  });

  it('is refused without the approvals of the current production', async () => {
    await withTestTransaction(
      async (db) => {
        const storage = new FakeStorage();
        const w = await createPiezaAprobable(db, storage);
        for (const e of ['esperando_aprobacion', 'aprobada', 'programada', 'fallo_publicacion']) await moverPieza(db, w.piezaId, e);
        await expect(programarPieza({ db, storage }, asClienteId(w.clienteId), w.piezaId, new Date(Date.now() + DIA), sistema)).rejects.toBeInstanceOf(SinAprobacionVigenteError);
      },
      { sinGuardaDeAprobacion: true },
    );
  });
});
