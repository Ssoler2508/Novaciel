import { readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupDomainTables } from '../../../tests/utils/cleanup.js';
import { createPiezaProgramada, SECRETO_FICTICIO, type PiezaProgramada } from '../../../tests/utils/publicacionWorld.js';
import { closeTestPool, getTestPool } from '../../../tests/utils/testPool.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import {
  createAprobacion,
  createConexionRed,
  createProduccion,
  createPublicacion,
  createPublicacionResultado,
  createPiezaAprobable,
  moverPieza,
} from '../../../tests/utils/factories/index.js';
import { runInTransaction } from '../../db/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeNotifier } from '../../lib/notificaciones/notifiers.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { FakePublishProvider } from '../../lib/publish/fakePublishProvider.js';
import type { PublishProvider } from '../../lib/publish/types.js';
import { ArchivoAlteradoError, ControlCalidadNoAprobadoError, SinAprobacionVigenteError } from '../aprobaciones/errors.js';
import { ProduccionHechoVencidoError } from '../produccion/errors.js';
import { getPieza } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { asClienteId } from '../shared/clienteId.js';
import { claveIdempotencia } from './claveIdempotencia.js';
import {
  ArchivoAlteradoAlEnviarError,
  ConexionNoDisponibleError,
  EtiquetaIaNoSoportadaError,
  PiezaEstadoProgramacionError,
  PublicacionPrematuraError,
} from './errors.js';
import { publicarPieza, VENTANA_EN_CURSO_MS, type PublicacionDeps } from './publicacionService.js';

// The central rule at the point of sending. The provider is the fake; global fetch is replaced by a mock
// that fails the test if anything ever reaches for the network.

const sistema = { tipo: 'sistema' } as const;
const fetchMock = vi.fn(() => {
  throw new Error('network access is forbidden in tests');
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

function capturedLogger() {
  const lines: string[] = [];
  return { log: createLogger('debug', { write: (l: string) => void lines.push(l) }), text: () => lines.join('') };
}

const tmpFolders = () => readdirSync(tmpdir()).filter((n) => n.startsWith('novaciel-publicar-')).length;

function armar(db: Db, p: PiezaProgramada, provider: PublishProvider, extra: Partial<PublicacionDeps> = {}) {
  const cap = capturedLogger();
  const deps: PublicacionDeps = { db, storage: p.storage, provider, alertas: { db, notifier: new FakeNotifier(), logger: cap.log }, logger: cap.log, ...extra };
  return { deps, cap };
}

const intentos = async (db: Db, piezaId: string) =>
  (await db.query('SELECT p.numero_intento, p.etiqueta_ia, p.clave_idempotencia FROM publicaciones p WHERE p.pieza_id = $1 ORDER BY p.numero_intento', [piezaId])).rows;
const resultados = async (db: Db, piezaId: string) =>
  (await db.query('SELECT estado, categoria_error, id_externo FROM publicaciones_resultados WHERE pieza_id = $1 ORDER BY seq', [piezaId])).rows;
const alertas = async (db: Db, clienteId: string) =>
  (await db.query<{ codigo: string; parametros: Record<string, unknown> }>('SELECT codigo, parametros FROM alertas WHERE cliente_id = $1 ORDER BY creado_en', [clienteId])).rows;
const estadoPieza = async (db: Db, p: PiezaProgramada) => (await getPieza(db, p.clienteId, p.w.piezaId))!.estado;
const claveDe = (p: PiezaProgramada) => claveIdempotencia({ piezaId: p.w.piezaId, produccionId: p.w.produccionId, hashPieza: p.w.hashPieza });
const enMinutos = (m: number) => () => new Date(Date.now() + m * 60_000);

describe('a successful publication', () => {
  it('records the attempt and the result, sends the stored files and copy, moves the piece to publicada and audits', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider();
      const { deps } = armar(db, p, provider);
      const antes = tmpFolders();

      const r = await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema);
      expect(r).toMatchObject({ estado: 'publicada', intento: 1, yaEstabaPublicada: false });
      expect(provider.publishCalls).toBe(1);
      expect(provider.calls[0]).toMatchObject({ op: 'publish', clave: claveDe(p), archivos: 2, etiquetaIa: false, red: 'instagram' });
      expect(await estadoPieza(db, p)).toBe('publicada');
      expect(await intentos(db, p.w.piezaId)).toEqual([{ numero_intento: 1, etiqueta_ia: false, clave_idempotencia: claveDe(p) }]);
      expect(await resultados(db, p.w.piezaId)).toEqual([{ estado: 'publicada', categoria_error: null, id_externo: FakePublishProvider.resultFor(claveDe(p)).idExterno }]);
      const audit = await db.query(`SELECT datos_despues FROM auditoria WHERE accion = 'publicar_pieza' AND fila_id = $1`, [p.w.piezaId]);
      expect(audit.rows).toHaveLength(1);
      expect(tmpFolders()).toBe(antes);
    });
  });

  it('a second call does not send again: the piece is no longer programada', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider();
      const { deps } = armar(db, p, provider);
      await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema);
      await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).rejects.toBeInstanceOf(PiezaEstadoProgramacionError);
      expect(provider.publishCalls).toBe(1);
    });
  });

  it('is refused before its time and for a piece of another client', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const otro = await createPiezaProgramada(db);
      const provider = new FakePublishProvider();
      const { deps } = armar(db, p, provider);
      await db.query(`UPDATE piezas SET fecha_hora = now() + interval '1 hour' WHERE id = $1`, [p.w.piezaId]);
      await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).rejects.toBeInstanceOf(PublicacionPrematuraError);
      await expect(publicarPieza(deps, otro.clienteId, p.w.piezaId, sistema)).rejects.toThrow('not found');
      expect(provider.calls).toEqual([]);
    });
  });
});

describe('the gate refuses before any call', () => {
  async function refused(db: Db, p: PiezaProgramada, error: new (...a: never[]) => Error, motivo: string) {
    const provider = new FakePublishProvider();
    const { deps } = armar(db, p, provider);
    await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).rejects.toBeInstanceOf(error);
    expect(provider.calls).toEqual([]);
    expect(await intentos(db, p.w.piezaId)).toEqual([]);
    expect(await estadoPieza(db, p)).toBe('fallo_publicacion');
    expect((await alertas(db, p.w.clienteId)).map((a) => [a.codigo, a.parametros['motivo']])).toEqual([['publicacion_fallida', motivo]]);
  }

  it('a stored file changed in storage', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await p.storage.put(p.w.claves[0]!, Buffer.from('cambiado'), 'image/jpeg');
      await refused(db, p, ArchivoAlteradoError, 'compuerta_ArchivoAlteradoError');
    });
  });

  it('a fact expired after the approval', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await db.query(`UPDATE hechos_verificados SET vigente_hasta = now() - interval '1 hour' WHERE id = $1`, [p.w.hechoId]);
      await refused(db, p, ProduccionHechoVencidoError, 'compuerta_ProduccionHechoVencidoError');
    });
  });

  it('no approvals at all', async () => {
    await withTestTransaction(
      async (db) => {
        const storage = new FakeStorage();
        const w = await createPiezaAprobable(db, storage);
        for (const e of ['esperando_aprobacion', 'aprobada', 'programada']) await moverPieza(db, w.piezaId, e);
        await db.query(`UPDATE piezas SET fecha_hora = now() - interval '1 minute' WHERE id = $1`, [w.piezaId]);
        await createConexionRed(db, { clienteId: w.clienteId, red: 'instagram' });
        const p: PiezaProgramada = { w, actores: undefined as never, clienteId: asClienteId(w.clienteId), storage, secreto: null };
        await refused(db, p, SinAprobacionVigenteError, 'compuerta_SinAprobacionVigenteError');
      },
      { sinGuardaDeAprobacion: true },
    );
  });

  it('a new production version after the approvals', async () => {
    await withTestTransaction(
      async (db) => {
        const p = await createPiezaProgramada(db);
        for (const e of ['con_cambios', 'en_produccion']) await moverPieza(db, p.w.piezaId, e);
        await createProduccion(db, { piezaId: p.w.piezaId });
        for (const e of ['en_control_calidad', 'revision_novaciel', 'esperando_aprobacion', 'aprobada', 'programada']) await moverPieza(db, p.w.piezaId, e);
        await db.query(`UPDATE piezas SET fecha_hora = now() - interval '1 minute' WHERE id = $1`, [p.w.piezaId]);
        const provider = new FakePublishProvider();
        const { deps } = armar(db, p, provider);
        await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).rejects.toBeInstanceOf(SinAprobacionVigenteError);
        expect(provider.calls).toEqual([]);
        expect(await intentos(db, p.w.piezaId)).toEqual([]);
        expect(await estadoPieza(db, p)).toBe('fallo_publicacion');
      },
      { sinGuardaDeAprobacion: true },
    );
  });

  it('a quality-control report missing', async () => {
    await withTestTransaction(
      async (db) => {
        const storage = new FakeStorage();
        const w = await createPiezaAprobable(db, storage, { sinInformeQC: true });
        await createAprobacion(db, { piezaId: w.piezaId, nivel: 'interno' });
        await moverPieza(db, w.piezaId, 'esperando_aprobacion');
        await createAprobacion(db, { piezaId: w.piezaId, nivel: 'cliente' });
        await moverPieza(db, w.piezaId, 'aprobada');
        await moverPieza(db, w.piezaId, 'programada');
        await db.query(`UPDATE piezas SET fecha_hora = now() - interval '1 minute' WHERE id = $1`, [w.piezaId]);
        await createConexionRed(db, { clienteId: w.clienteId, red: 'instagram' });
        const p: PiezaProgramada = { w, actores: undefined as never, clienteId: asClienteId(w.clienteId), storage, secreto: null };
        await refused(db, p, ControlCalidadNoAprobadoError, 'compuerta_ControlCalidadNoAprobadoError');
      },
      { sinGuardaDeAprobacion: true },
    );
  });
});

describe('a file that changes between the gate and the send', () => {
  class StorageQueCambia extends FakeStorage {
    reads = 0;
    /** Reads after this many come back with different bytes. */
    desde = Number.POSITIVE_INFINITY;
    override async getFile(key: string, dest: string): Promise<void> {
      this.reads += 1;
      if (this.reads > this.desde) return writeFile(dest, 'bytes distintos');
      return super.getFile(key, dest);
    }
  }

  it('is not sent: attempt closed as failed, piece in fallo_publicacion, critical alert, temp folder removed', async () => {
    await withTestTransaction(async (db) => {
      // The gate reads each of the 2 files once; the third read (phase 2) comes back different.
      const storage = new StorageQueCambia();
      const p = await createPiezaProgramada(db, { storage });
      storage.reads = 0;
      storage.desde = 2;
      const provider = new FakePublishProvider();
      const { deps } = armar(db, p, provider);
      const antes = tmpFolders();
      await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).rejects.toBeInstanceOf(ArchivoAlteradoAlEnviarError);
      expect(provider.calls).toEqual([]);
      expect(await resultados(db, p.w.piezaId)).toEqual([{ estado: 'fallida', categoria_error: 'bad_request', id_externo: null }]);
      expect(await estadoPieza(db, p)).toBe('fallo_publicacion');
      expect((await alertas(db, p.w.clienteId)).map((a) => a.parametros['motivo'])).toEqual(['archivo_alterado_al_enviar']);
      expect(tmpFolders()).toBe(antes);
    });
  });
});

describe('connections', () => {
  it.each([
    ['missing', { conexion: false }, 'ausente'],
    ['revoked', { revocar: true }, 'ausente'],
    ['expired', { vencer: true }, 'vencida'],
  ] as const)('%s: no send, conexion_red_vencida, piece in fallo_publicacion', async (_n, o, motivo) => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db, { conexion: !('conexion' in o) });
      if ('revocar' in o) await db.query('UPDATE conexiones_redes SET revocada_en = now() WHERE cliente_id = $1', [p.w.clienteId]);
      if ('vencer' in o) await db.query(`UPDATE conexiones_redes SET expira_en = now() - interval '1 hour' WHERE cliente_id = $1`, [p.w.clienteId]);
      const provider = new FakePublishProvider();
      const { deps } = armar(db, p, provider);
      const error = await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConexionNoDisponibleError);
      expect((error as ConexionNoDisponibleError).motivo).toBe(motivo);
      expect(provider.calls).toEqual([]);
      expect(await intentos(db, p.w.piezaId)).toEqual([]);
      expect(await estadoPieza(db, p)).toBe('fallo_publicacion');
      expect((await alertas(db, p.w.clienteId)).map((a) => a.codigo)).toEqual(['conexion_red_vencida']);
    });
  });
});

describe('the AI-content label', () => {
  it('goes out set for a piece with synthetic voice, and the attempt records it', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db, { conVoz: true });
      const provider = new FakePublishProvider();
      const { deps } = armar(db, p, provider);
      await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema);
      expect(provider.calls[0]).toMatchObject({ op: 'publish', etiquetaIa: true });
      expect((await intentos(db, p.w.piezaId))[0]!.etiqueta_ia).toBe(true);
    });
  });

  it('is blocked, with an alert, when the provider cannot set it on that network', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db, { conVoz: true });
      const provider = new FakePublishProvider({ etiquetaIa: false });
      const { deps } = armar(db, p, provider);
      await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).rejects.toBeInstanceOf(EtiquetaIaNoSoportadaError);
      expect(provider.calls).toEqual([]);
      expect(await intentos(db, p.w.piezaId)).toEqual([]);
      expect(await estadoPieza(db, p)).toBe('fallo_publicacion');
      expect((await alertas(db, p.w.clienteId)).map((a) => a.codigo)).toEqual(['etiqueta_ia_no_soportada']);
    });
  });

  it('a piece without synthetic voice is not blocked by a provider that cannot set the label', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider({ etiquetaIa: false });
      const { deps } = armar(db, p, provider);
      await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).resolves.toMatchObject({ estado: 'publicada' });
    });
  });
});

describe('retries', () => {
  it('a transient error is retried: the piece stays programada and the second call publishes without a second post', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider().scriptPublish({ fail: 'server' });
      const { deps } = armar(db, p, provider, { random: () => 0.5 });
      const r1 = await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema);
      expect(r1).toMatchObject({ estado: 'reintento', intento: 1, categoria: 'server', esperaMs: 30_000 });
      expect(await estadoPieza(db, p)).toBe('programada');
      const r2 = await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema);
      expect(r2).toMatchObject({ estado: 'publicada', intento: 2 });
      expect(provider.posts).toBe(1);
      expect((await resultados(db, p.w.piezaId)).map((r) => r.estado)).toEqual(['fallida', 'publicada']);
      // The retry asked the provider by key before anything else.
      expect(provider.calls.map((c) => c.op)).toEqual(['publish', 'findByKey', 'publish']);
    });
  });

  it('the Retry-After of the provider is respected', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider().scriptPublish({ fail: 'rate_limit', retryAfterMs: 120_000 });
      const { deps } = armar(db, p, provider);
      await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).resolves.toMatchObject({ estado: 'reintento', esperaMs: 120_000 });
    });
  });

  it('an auth error is not retried: fallo_publicacion and conexion_red_vencida', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider().scriptPublish({ fail: 'auth', status: 401 });
      const { deps } = armar(db, p, provider);
      await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).resolves.toMatchObject({ estado: 'fallida', categoria: 'auth' });
      expect(await estadoPieza(db, p)).toBe('fallo_publicacion');
      expect((await alertas(db, p.w.clienteId)).map((a) => a.codigo)).toEqual(['conexion_red_vencida']);
      await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).rejects.toBeInstanceOf(PiezaEstadoProgramacionError);
      expect(provider.publishCalls).toBe(1);
    });
  });

  it('the retries are bounded: the third transient failure is final', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider().scriptPublish({ fail: 'server' }, { fail: 'server' }, { fail: 'timeout' });
      const { deps } = armar(db, p, provider);
      const estados = [];
      for (let i = 0; i < 3; i++) estados.push((await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).estado);
      expect(estados).toEqual(['reintento', 'reintento', 'fallida']);
      expect(await estadoPieza(db, p)).toBe('fallo_publicacion');
      expect((await intentos(db, p.w.piezaId)).map((i) => i.numero_intento)).toEqual([1, 2, 3]);
      expect((await alertas(db, p.w.clienteId)).map((a) => [a.codigo, a.parametros['motivo']])).toEqual([['publicacion_fallida', 'sin_reintentos']]);
    });
  });
});

describe('an outcome that is not known', () => {
  it('a connection lost after the post went out: the retry finds it by key and sends nothing', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider().scriptPublish({ crashAfterSend: true });
      const { deps } = armar(db, p, provider);
      expect(await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).toMatchObject({ estado: 'reintento', categoria: 'timeout' });
      const r = await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema);
      expect(r).toMatchObject({ estado: 'publicada', yaEstabaPublicada: true, idExterno: FakePublishProvider.resultFor(claveDe(p)).idExterno });
      expect(provider.publishCalls).toBe(1);
      expect(provider.posts).toBe(1);
      expect(await estadoPieza(db, p)).toBe('publicada');
    });
  });

  it('an unclassified provider failure is `desconocida` with an alert; the next call finds the post by key and settles it', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider();
      const spy = vi.spyOn(provider, 'publish').mockImplementationOnce(async (req) => {
        provider.preRegister(req.claveIdempotencia);
        throw new Error('connection reset by peer');
      });
      const { deps } = armar(db, p, provider);
      expect(await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).toMatchObject({ estado: 'desconocida', agotada: false });
      expect(await estadoPieza(db, p)).toBe('programada');
      expect((await alertas(db, p.w.clienteId)).map((a) => a.codigo)).toEqual(['publicacion_resultado_desconocido']);

      const r = await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema);
      expect(r).toMatchObject({ estado: 'publicada', intento: 1, yaEstabaPublicada: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await resultados(db, p.w.piezaId)).map((x) => x.estado)).toEqual(['desconocida', 'publicada']);
      expect((await intentos(db, p.w.piezaId)).length).toBe(1);
    });
  });

  it('an attempt with no result younger than 10 minutes is in flight: no provider call at all', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await createPublicacion(db, { piezaId: p.w.piezaId, claveIdempotencia: claveDe(p) });
      const provider = new FakePublishProvider();
      const { deps } = armar(db, p, provider, { now: enMinutos(VENTANA_EN_CURSO_MS / 60_000 - 1) });
      expect(await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).toEqual({ estado: 'en_curso' });
      expect(provider.calls).toEqual([]);
    });
  });

  it('an attempt with no result older than 10 minutes crashed: it is looked up by key, and found, nothing is sent', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await createPublicacion(db, { piezaId: p.w.piezaId, claveIdempotencia: claveDe(p) });
      const provider = new FakePublishProvider();
      provider.preRegister(claveDe(p));
      const { deps } = armar(db, p, provider, { now: enMinutos(VENTANA_EN_CURSO_MS / 60_000 + 1) });
      expect(await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).toMatchObject({ estado: 'publicada', intento: 1, yaEstabaPublicada: true });
      expect(provider.publishCalls).toBe(0);
      expect((await intentos(db, p.w.piezaId)).length).toBe(1);
      expect(await estadoPieza(db, p)).toBe('publicada');
    });
  });

  it('a crashed attempt the provider never saw is settled as failed and the next attempt sends', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await createPublicacion(db, { piezaId: p.w.piezaId, claveIdempotencia: claveDe(p) });
      const provider = new FakePublishProvider();
      const { deps } = armar(db, p, provider, { now: enMinutos(11) });
      expect(await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).toMatchObject({ estado: 'publicada', intento: 2, yaEstabaPublicada: false });
      expect(provider.publishCalls).toBe(1);
      expect((await resultados(db, p.w.piezaId)).map((x) => x.estado)).toEqual(['fallida', 'publicada']);
    });
  });

  it('a lookup that fails leaves the outcome unknown and sends nothing', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      await createPublicacion(db, { piezaId: p.w.piezaId, claveIdempotencia: claveDe(p) });
      const provider = new FakePublishProvider().scriptLookupFailure('timeout');
      const { deps } = armar(db, p, provider, { now: enMinutos(11) });
      expect(await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).toMatchObject({ estado: 'desconocida', agotada: false });
      expect(provider.publishCalls).toBe(0);
      expect((await resultados(db, p.w.piezaId)).map((x) => x.estado)).toEqual(['desconocida']);
    });
  });

  it('the verifications count toward the 3 attempts: used up with no known outcome it stays desconocida and is never resent', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      for (let n = 1; n <= 2; n++) {
        const a = await createPublicacion(db, { piezaId: p.w.piezaId, claveIdempotencia: claveDe(p) });
        await createPublicacionResultado(db, { publicacionId: a.id, estado: 'fallida', categoriaError: 'timeout' });
      }
      await createPublicacion(db, { piezaId: p.w.piezaId, claveIdempotencia: claveDe(p) }); // the third crashed
      const provider = new FakePublishProvider();
      const { deps } = armar(db, p, provider, { now: enMinutos(11) });
      for (let i = 0; i < 2; i++) {
        expect(await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).toMatchObject({ estado: 'desconocida', intento: 3, agotada: true });
      }
      expect(provider.publishCalls).toBe(0);
      expect((await intentos(db, p.w.piezaId)).length).toBe(3);
      expect((await resultados(db, p.w.piezaId)).map((x) => x.estado)).toEqual(['fallida', 'fallida', 'desconocida']);
      expect(await estadoPieza(db, p)).toBe('programada');
      expect((await alertas(db, p.w.clienteId)).map((a) => a.codigo)).toEqual(['publicacion_resultado_desconocido']);
    });
  });
});

describe('the production changes while the post is being sent', () => {
  it('the result stays recorded, the piece is not moved, and NovaCiel is alerted', async () => {
    await withTestTransaction(async (db) => {
      const p = await createPiezaProgramada(db);
      const provider = new FakePublishProvider();
      const original = provider.publish.bind(provider);
      vi.spyOn(provider, 'publish').mockImplementationOnce(async (req, ctx) => {
        await transitionPieza(db, p.clienteId, p.w.piezaId, 'con_cambios', sistema, { motivo: 'cambio durante el envio' });
        return original(req, ctx);
      });
      const { deps } = armar(db, p, provider);
      const r = await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema);
      expect(r.estado).toBe('publicada');
      expect(await estadoPieza(db, p)).toBe('con_cambios');
      expect((await resultados(db, p.w.piezaId)).map((x) => x.estado)).toEqual(['publicada']);
      expect((await alertas(db, p.w.clienteId)).map((a) => a.parametros['motivo'])).toEqual(['produccion_cambiada_tras_envio']);
    });
  });
});

describe('credentials and client text never leak', () => {
  it('the secret appears in no log, error, result, alert or audit row, on success and on every kind of failure', async () => {
    await withTestTransaction(async (db) => {
      const salidas: unknown[] = [];
      const textos: string[] = [];
      const escenarios: Array<(p: FakePublishProvider) => void> = [
        () => undefined,
        (f) => void f.scriptPublish({ fail: 'auth', status: 401 }),
        (f) => void f.scriptPublish({ fail: 'server' }),
        (f) => void f.scriptPublish({ crashAfterSend: true }),
      ];
      for (const preparar of escenarios) {
        const p = await createPiezaProgramada(db, { secreto: SECRETO_FICTICIO });
        const provider = new FakePublishProvider();
        preparar(provider);
        const { deps, cap } = armar(db, p, provider);
        const salida = await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema).catch((e: unknown) => e);
        salidas.push(salida, ...(salida instanceof Error ? [salida.message, salida.stack ?? ''] : []));
        textos.push(cap.text());
        textos.push(JSON.stringify((await alertas(db, p.w.clienteId))));
        textos.push(JSON.stringify((await db.query('SELECT datos_antes, datos_despues FROM auditoria WHERE cliente_id = $1', [p.w.clienteId])).rows));
        textos.push(JSON.stringify(provider.calls));
      }
      // A provider error and a gate refusal as thrown objects too.
      const q = await createPiezaProgramada(db, { secreto: SECRETO_FICTICIO });
      await q.storage.put(q.w.claves[0]!, Buffer.from('x'), 'image/jpeg');
      const { deps, cap } = armar(db, q, new FakePublishProvider());
      const error = await publicarPieza(deps, q.clienteId, q.w.piezaId, sistema).catch((e: unknown) => e);
      salidas.push(error, (error as Error).message);
      textos.push(cap.text());

      const todo = JSON.stringify(salidas) + textos.join('\n');
      expect(todo).not.toContain(SECRETO_FICTICIO);
      expect(todo).not.toContain('Texto de publicación ficticio');
      expect(todo).not.toContain('#ficticio');
    });
  });
});

// ---- Real, separate connections: two calls at once ----------------------------------------------------------

describe('two publishes of the same piece at the same time', () => {
  beforeEach(async () => {
    await cleanupDomainTables(getTestPool());
  });
  afterAll(async () => {
    await cleanupDomainTables(getTestPool());
    await closeTestPool();
  });

  it('while the first call is inside the provider, the second gets en_curso and makes no call: exactly one send', async () => {
    const pool = getTestPool();
    const p = await runInTransaction(pool, (tx) => createPiezaProgramada(tx));
    // The provider does not know the key until the first call is released: a lookup by key would find nothing.
    const provider = new FakePublishProvider();
    const barrera = provider.holdNextPublish();
    const deps: PublicacionDeps = { db: pool, storage: p.storage, provider, logger: capturedLogger().log };

    const primera = publicarPieza(deps, p.clienteId, p.w.piezaId, sistema);
    try {
      await barrera.entered; // the first attempt is recorded and the first call is blocked inside publish()
      expect(await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).toEqual({ estado: 'en_curso' });
      expect(provider.publishCalls).toBe(1);
      expect(provider.calls.filter((c) => c.op === 'findByKey')).toEqual([]);
    } finally {
      barrera.release();
    }
    expect(await primera).toMatchObject({ estado: 'publicada', intento: 1 });
    expect(provider.publishCalls).toBe(1);
    expect(provider.posts).toBe(1);
    expect(await intentos(pool, p.w.piezaId)).toHaveLength(1);
    expect(await resultados(pool, p.w.piezaId)).toHaveLength(1);
    expect(await estadoPieza(pool, p)).toBe('publicada');
  });

  it('a second call after the first finished is refused and makes no second send', async () => {
    const pool = getTestPool();
    const p = await runInTransaction(pool, (tx) => createPiezaProgramada(tx));
    const provider = new FakePublishProvider();
    const deps: PublicacionDeps = { db: pool, storage: p.storage, provider, logger: capturedLogger().log };

    expect(await publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).toMatchObject({ estado: 'publicada' });
    await expect(publicarPieza(deps, p.clienteId, p.w.piezaId, sistema)).rejects.toBeInstanceOf(PiezaEstadoProgramacionError);
    expect(provider.publishCalls).toBe(1);
    expect(provider.posts).toBe(1);
    expect(await intentos(pool, p.w.piezaId)).toHaveLength(1);
    expect(await resultados(pool, p.w.piezaId)).toHaveLength(1);
  });
});
