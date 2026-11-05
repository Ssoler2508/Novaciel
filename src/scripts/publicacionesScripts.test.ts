import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createActores, createConexionRed, createPiezaAprobable, createUsuario, assignRole } from '../../tests/utils/factories/index.js';
import type { Db } from '../db/types.js';
import { FakeStorage } from '../lib/media/storage/fakeStorage.js';
import { FakePublishProvider } from '../lib/publish/fakePublishProvider.js';
import { registrarDecision } from '../modules/aprobaciones/aprobacionesService.js';
import { getPieza } from '../modules/piezas/piezasRepository.js';
import { asClienteId } from '../modules/shared/clienteId.js';
import { FakePublicacionQueue } from '../modules/publicaciones/publicacionQueue.js';
import { parsePieceScheduleArgs, parsePiecePublishArgs, parsePublishMetricsArgs } from './publicacionesArgs.js';
import { runPiecePublish, runPieceSchedule, runPublishMetrics } from './publicacionesCore.js';
import { SEED_ADMIN_EMAIL } from './seedDevelopment.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const ID2 = '223e4567-e89b-42d3-a456-426614174001';
const DIA = 86_400_000;

describe('the arguments of the Step 10 scripts', () => {
  const mensaje = (parse: (argv: string[]) => unknown, argv: string[]) => {
    try {
      parse(argv);
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };

  it('piece:schedule takes --cliente, --pieza and an ISO --at with an offset', () => {
    expect(parsePieceScheduleArgs(['--cliente', ID, '--pieza', ID2, '--at', '2026-11-10T15:00:00-05:00'])).toEqual({
      clienteId: ID,
      piezaId: ID2,
      at: new Date('2026-11-10T20:00:00Z'),
    });
    expect(parsePieceScheduleArgs([`--cliente=${ID}`, `--pieza=${ID2}`, '--at=2026-11-10T20:00Z']).at.toISOString()).toBe('2026-11-10T20:00:00.000Z');
    for (const bad of [
      ['--cliente', ID, '--pieza', ID2],
      ['--cliente', ID, '--pieza', ID2, '--at', 'mañana'],
      ['--cliente', ID, '--pieza', ID2, '--at', '2026-11-10'],
      ['--cliente', ID, '--pieza', ID2, '--at', '2026-11-10T15:00:00'],
      ['--cliente', 'secret-x', '--pieza', ID2, '--at', '2026-11-10T15:00Z'],
      ['--cliente', ID, '--pieza', ID2, '--at', '2026-11-10T15:00Z', '--x', '1'],
    ]) {
      const m = mensaje(parsePieceScheduleArgs, bad);
      expect(m, JSON.stringify(bad)).not.toBe('');
      expect(m).not.toContain('secret-x');
    }
  });

  it('piece:publish and publish:metrics take --cliente and --pieza only', () => {
    for (const parse of [parsePiecePublishArgs, parsePublishMetricsArgs]) {
      expect(parse(['--cliente', ID, '--pieza', ID2])).toEqual({ clienteId: ID, piezaId: ID2 });
      for (const bad of [[], ['--cliente', ID], ['--pieza', ID2], ['--cliente', ID, '--pieza', 'x'], ['--cliente', ID, '--pieza', ID2, '--at', '2026-11-10T15:00Z']]) {
        expect(mensaje(parse, bad), JSON.stringify(bad)).not.toBe('');
      }
    }
  });
});

describe('the Step 10 development scripts', () => {
  async function world(db: Db) {
    const admin = await createUsuario(db, { email: SEED_ADMIN_EMAIL });
    await assignRole(db, { usuarioId: admin.id, rolCodigo: 'administrador_novaciel', clienteId: null });
    const storage = new FakeStorage();
    const w = await createPiezaAprobable(db, storage);
    const actores = await createActores(db, w.clienteId);
    const clienteId = asClienteId(w.clienteId);
    await registrarDecision({ db }, clienteId, w.piezaId, actores.novaciel, { nivel: 'interno', decision: 'aprobada', hashVisto: w.hashHex });
    await registrarDecision({ db }, clienteId, w.piezaId, actores.cliente, { nivel: 'cliente', decision: 'aprobada', hashVisto: w.hashHex });
    await createConexionRed(db, { clienteId: w.clienteId, red: 'instagram' });
    return { storage, w, clienteId, deps: { db, storage, provider: new FakePublishProvider() } };
  }

  it('schedule -> publish now -> metrics, then a second publish does not send again', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      const publicaciones = new FakePublicacionQueue();
      const at = new Date(Date.now() + 3 * DIA);
      const programada = await runPieceSchedule({ ...x.deps, publicaciones }, { clienteId: x.clienteId, piezaId: x.w.piezaId, at });
      expect(programada.ok).toBe(true);
      expect(programada.lines.join('\n')).toContain('programada');
      expect(publicaciones.programados).toHaveLength(1);

      // The time has not come, but the script skips only the wait.
      const publicada = await runPiecePublish(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId });
      expect(publicada).toMatchObject({ ok: true });
      expect(publicada.lines[0]).toContain('PUBLISHED');
      expect(x.deps.provider.publishCalls).toBe(1);
      expect((await getPieza(db, x.clienteId, x.w.piezaId))!.estado).toBe('publicada');

      const otra = await runPiecePublish(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId });
      expect(otra.ok).toBe(false);
      expect(x.deps.provider.publishCalls).toBe(1);

      const m1 = await runPublishMetrics(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId });
      expect(m1.ok).toBe(true);
      expect(m1.lines[0]).toContain('Window 24h collected');
      expect((await getPieza(db, x.clienteId, x.w.piezaId))!.estado).toBe('en_medicion');
      const m2 = await runPublishMetrics(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId });
      expect(m2.lines[0]).toContain('Window 72h collected');
    });
  });

  it('reschedules a programada piece, and refuses a time in the past without changing it', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      const at = new Date(Date.now() + 3 * DIA);
      await runPieceSchedule(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId, at });
      const nuevo = new Date(Date.now() + 5 * DIA);
      expect((await runPieceSchedule(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId, at: nuevo })).ok).toBe(true);
      expect((await getPieza(db, x.clienteId, x.w.piezaId))!.fecha_hora.getTime()).toBe(nuevo.getTime());
      const pasado = await runPieceSchedule(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId, at: new Date(Date.now() - DIA) });
      expect(pasado).toMatchObject({ ok: false });
      expect(pasado.lines[0]).toContain('fecha_pasada');
    });
  });

  it('refuses to publish a tampered file: nothing is sent and the output names the error, not the content', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      await runPieceSchedule(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId, at: new Date(Date.now() + 3 * DIA) });
      await x.storage.put(x.w.claves[0]!, Buffer.from('alterado'), 'image/jpeg');
      const r = await runPiecePublish(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId });
      expect(r.ok).toBe(false);
      expect(r.lines[0]).toContain('ArchivoAlteradoError');
      expect(x.deps.provider.calls).toEqual([]);
      expect((await getPieza(db, x.clienteId, x.w.piezaId))!.estado).toBe('fallo_publicacion');
    });
  });

  it('answers clearly for a piece that is not in the right state or was never published', async () => {
    await withTestTransaction(async (db) => {
      const x = await world(db);
      expect((await runPiecePublish(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId })).lines[0]).toContain('aprobada');
      expect((await runPublishMetrics(x.deps, { clienteId: x.clienteId, piezaId: x.w.piezaId })).lines[0]).toContain('not published');
      expect((await runPiecePublish(x.deps, { clienteId: x.clienteId, piezaId: ID })).lines[0]).toContain('does not exist');
    });
  });
});
