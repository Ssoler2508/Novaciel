import { randomUUID } from 'node:crypto';
import type { Job } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createCliente,
  createLibroGasto,
  createPrecioModelo,
  createTope,
  createUsuarioConRol,
  currentPeriodo,
} from '../../../tests/utils/factories/index.js';
import { producibleWorld } from '../../../tests/utils/produccionWorld.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { FakeLLMProvider } from '../../lib/ai/index.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeNotifier } from '../../lib/notificaciones/notifiers.js';
import { generateStructured } from '../ai/generateStructured.js';
import { ejecutarQC } from '../controlCalidad/ejecutarQC.js';
import { setClientSpendSwitch, setGlobalSpendSwitch } from '../presupuesto/presupuestoAdmin.js';
import { getProduccionActual, producirPieza } from '../produccion/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { fallosDeVozYCapa } from './catalogo.js';
import { PersistentAlertSink } from './persistentAlertSink.js';
import type { AlertasRuntime } from './raiseAlert.js';
import { evaluarUmbrales } from './umbrales.js';
import { withFailureAlert } from './withFailureAlert.js';

const SISTEMA = { tipo: 'sistema' } as const;
const SECRETO = 'SECRETO-DEL-CLIENTE-4471';

const codigosDe = async (db: Db, clienteId: string | null) =>
  (await db.query<{ codigo: string }>(`SELECT codigo FROM alertas WHERE cliente_id IS NOT DISTINCT FROM $1 ORDER BY codigo`, [clienteId])).rows.map((r) => r.codigo);

function runtime(db: Db, notifier = new FakeNotifier(), umbrales: readonly number[] = [50, 80, 100]): AlertasRuntime {
  return { db, notifier, umbrales, logger: createLogger('silent') };
}

describe('budget thresholds (evaluarUmbrales)', () => {
  it('raises 50, 80 and 100 once each as the spend grows, and never again', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const clienteId = asClienteId(cliente.id);
      const owner = await createUsuarioConRol(db, 'dueno_cliente', cliente.id);
      await createTope(db, { clienteId: cliente.id, montoTecho: '10' });
      const notifier = new FakeNotifier();
      const rt = runtime(db, notifier);

      await evaluarUmbrales(rt, clienteId);
      expect(await codigosDe(db, cliente.id)).toEqual([]);

      await createLibroGasto(db, { clienteId: cliente.id, costoReal: '5.000000' });
      await evaluarUmbrales(rt, clienteId);
      expect(await codigosDe(db, cliente.id)).toEqual(['presupuesto_umbral_50']);

      await createLibroGasto(db, { clienteId: cliente.id, costoReal: '3.000000' });
      await evaluarUmbrales(rt, clienteId);
      await evaluarUmbrales(rt, clienteId);
      expect(await codigosDe(db, cliente.id)).toEqual(['presupuesto_umbral_50', 'presupuesto_umbral_80']);
      expect(notifier.enviados.some((e) => e.destinatarioUsuarioId === owner.id)).toBe(false);

      await createLibroGasto(db, { clienteId: cliente.id, costoReal: '2.500000' });
      await evaluarUmbrales(rt, clienteId);
      expect(await codigosDe(db, cliente.id)).toEqual(['presupuesto_umbral_100', 'presupuesto_umbral_50', 'presupuesto_umbral_80']);
      // The owner hears about the ceiling being reached, once, with a template that has no figures.
      expect(notifier.enviados.filter((e) => e.destinatarioUsuarioId === owner.id).map((e) => e.plantilla)).toEqual(['presupuesto_techo_cliente']);

      const { rows } = await db.query<{ clave_dedupe: string; parametros: Record<string, unknown> }>(`SELECT clave_dedupe, parametros FROM alertas WHERE codigo = 'presupuesto_umbral_80' AND cliente_id = $1`, [cliente.id]);
      expect(rows[0]!.clave_dedupe).toBe(`presupuesto:${cliente.id}:${currentPeriodo()}:80`);
      expect(Object.keys(rows[0]!.parametros).sort()).toEqual(['periodo', 'porcentaje', 'umbral']);
    });
  });

  it('honours the configured thresholds, ignores a client without ceiling and does nothing without the runtime', async () => {
    await withTestTransaction(async (db) => {
      const a = await createCliente(db);
      await createTope(db, { clienteId: a.id, montoTecho: '10' });
      await createLibroGasto(db, { clienteId: a.id, costoReal: '9.000000' });
      await evaluarUmbrales(runtime(db, new FakeNotifier(), [80]), asClienteId(a.id));
      expect(await codigosDe(db, a.id)).toEqual(['presupuesto_umbral_80']);

      const sinTecho = await createCliente(db);
      await createLibroGasto(db, { clienteId: sinTecho.id, costoReal: '9.000000' });
      await evaluarUmbrales(runtime(db), asClienteId(sinTecho.id));
      expect(await codigosDe(db, sinTecho.id)).toEqual([]);

      const b = await createCliente(db);
      await createTope(db, { clienteId: b.id, montoTecho: '1' });
      await createLibroGasto(db, { clienteId: b.id, costoReal: '1.000000' });
      await evaluarUmbrales(undefined, asClienteId(b.id));
      expect(await codigosDe(db, b.id)).toEqual([]);
    });
  });

  it('a client never raises or shares an alert of another client', async () => {
    await withTestTransaction(async (db) => {
      const a = await createCliente(db);
      const b = await createCliente(db);
      await createTope(db, { clienteId: a.id, montoTecho: '10' });
      await createTope(db, { clienteId: b.id, montoTecho: '10' });
      await createLibroGasto(db, { clienteId: a.id, costoReal: '6.000000' });
      await evaluarUmbrales(runtime(db), asClienteId(a.id));
      expect(await codigosDe(db, a.id)).toEqual(['presupuesto_umbral_50']);
      expect(await codigosDe(db, b.id)).toEqual([]);
    });
  });

  it('through generateStructured: the call that crosses a threshold raises it, and no alert holds the prompt or the output', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const clienteId = asClienteId(cliente.id);
      await createTope(db, { clienteId: cliente.id, montoTecho: '0.1' });
      if ((await db.query(`SELECT 1 FROM precios_modelos WHERE proveedor = 'fake' AND modelo = 'fake-model'`)).rows.length === 0) {
        await createPrecioModelo(db, { proveedor: 'fake', modelo: 'fake-model', precioEntrada: '1', precioSalida: '2' });
      }
      // 25000 in + 12500 out tokens cost 0.05 USD each call: 50 % of the ceiling after one, 100 % after two.
      const provider = new FakeLLMProvider({ inputTokens: 25_000, outputTokens: 12_500 }).enqueue(JSON.stringify({ title: SECRETO }), JSON.stringify({ title: SECRETO }));
      const deps = { db, provider, alerts: new PersistentAlertSink(runtime(db)), alertas: runtime(db), logger: createLogger('silent') };
      const run = () =>
        generateStructured(deps, { clienteId, purpose: 'smoke_test_pesado', schema: z.object({ title: z.string() }), prompt: { system: 'Return JSON.', user: `Escribe sobre ${SECRETO}` }, maxOutputTokens: 1000, actor: SISTEMA });
      await run();
      expect(await codigosDe(db, cliente.id)).toEqual(['presupuesto_umbral_50']);
      await run();
      expect(await codigosDe(db, cliente.id)).toEqual(['presupuesto_umbral_100', 'presupuesto_umbral_50', 'presupuesto_umbral_80']);
      const todo = JSON.stringify((await db.query('SELECT * FROM alertas WHERE cliente_id = $1', [cliente.id])).rows);
      expect(todo).not.toContain(SECRETO);
    });
  });
});

describe('failed jobs (withFailureAlert)', () => {
  const job = (data: unknown = { texto: SECRETO }) => ({ id: randomUUID(), name: 'cola-x', data }) as unknown as Job<unknown>;

  it('a throwing handler raises trabajo_fallido with the queue, the job id and the error NAME only, and rethrows the same error', async () => {
    await withTestTransaction(async (db) => {
      const notifier = new FakeNotifier();
      const error = new RangeError(`boom ${SECRETO}`);
      const wrapped = withFailureAlert(runtime(db, notifier), 'control-calidad', async () => {
        throw error;
      });
      const j = job();
      await expect(wrapped([j])).rejects.toBe(error);
      const { rows } = await db.query<{ cliente_id: string | null; codigo: string; severidad: string; parametros: unknown; clave_dedupe: string }>(`SELECT cliente_id, codigo, severidad, parametros, clave_dedupe FROM alertas WHERE codigo = 'trabajo_fallido'`);
      expect(rows).toEqual([
        { cliente_id: null, codigo: 'trabajo_fallido', severidad: 'aviso', parametros: { cola: 'control-calidad', job_id: j.id, nombre_error: 'RangeError' }, clave_dedupe: `trabajo:control-calidad:${j.id}` },
      ]);
      expect(JSON.stringify(rows)).not.toContain(SECRETO);
      expect(JSON.stringify(notifier.enviados)).not.toContain(SECRETO);
      // The same job failing again (a retry) is the same alert.
      await expect(wrapped([j])).rejects.toBe(error);
      expect((await db.query(`SELECT 1 FROM alertas WHERE codigo = 'trabajo_fallido'`)).rows).toHaveLength(1);
    });
  });

  it('a handler that returns, also with a "rechazado" result, is not a failure; without alertas the handler is untouched', async () => {
    await withTestTransaction(async (db) => {
      const ok = withFailureAlert(runtime(db), 'cola', async () => ({ resultado: 'rechazado', codigo: 'PayloadInvalido' }));
      expect(await ok([job()])).toEqual({ resultado: 'rechazado', codigo: 'PayloadInvalido' });
      expect((await db.query(`SELECT 1 FROM alertas WHERE codigo = 'trabajo_fallido'`)).rows).toHaveLength(0);
      const handler = async () => 1;
      expect(withFailureAlert(undefined, 'cola', handler)).toBe(handler);
    });
  });

  it('an error whose name is not a safe code is reported as UnknownError', async () => {
    await withTestTransaction(async (db) => {
      const error = new Error('x');
      error.name = `Error con ${SECRETO} y espacios`;
      const j = job();
      await expect(withFailureAlert(runtime(db), 'cola', async () => Promise.reject(error))([j])).rejects.toBe(error);
      const { rows } = await db.query<{ parametros: { nombre_error: string } }>(`SELECT parametros FROM alertas WHERE codigo = 'trabajo_fallido'`);
      expect(rows[0]!.parametros.nombre_error).toBe('UnknownError');
    });
  });
});

describe('schema failures (PersistentAlertSink)', () => {
  it('two invalid outputs raise ONE llm_schema_invalid, keyed by the id of the second authorization, with no prompt or output', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const clienteId = asClienteId(cliente.id);
      await createTope(db, { clienteId: cliente.id, montoTecho: '10' });
      const staff = await createUsuarioConRol(db, 'operador_novaciel');
      if ((await db.query(`SELECT 1 FROM precios_modelos WHERE proveedor = 'fake' AND modelo = 'fake-model'`)).rows.length === 0) {
        await createPrecioModelo(db, { proveedor: 'fake', modelo: 'fake-model', precioEntrada: '1', precioSalida: '2' });
      }
      const notifier = new FakeNotifier();
      const provider = new FakeLLMProvider({ inputTokens: 100, outputTokens: 50 }).enqueue(`{"mal": "${SECRETO}"}`, `nope ${SECRETO}`);
      const deps = { db, provider, alerts: new PersistentAlertSink(runtime(db, notifier)), logger: createLogger('silent') };
      await expect(
        generateStructured(deps, { clienteId, purpose: 'smoke_test_pesado', schema: z.object({ title: z.string() }), prompt: { system: 'Return JSON.', user: `Escribe sobre ${SECRETO}` }, maxOutputTokens: 1000, actor: SISTEMA }),
      ).rejects.toMatchObject({ name: 'SchemaValidationError' });
      const second = (await db.query<{ autorizacion_id: string }>(`SELECT autorizacion_id FROM libro_gastos WHERE cliente_id = $1 ORDER BY id DESC LIMIT 1`, [cliente.id])).rows[0]!;
      const { rows } = await db.query<{ codigo: string; severidad: string; parametros: Record<string, unknown>; clave_dedupe: string }>('SELECT codigo, severidad, parametros, clave_dedupe FROM alertas WHERE cliente_id = $1', [cliente.id]);
      expect(rows).toEqual([
        {
          codigo: 'llm_schema_invalid',
          severidad: 'aviso',
          parametros: { proposito: 'smoke_test_pesado', proveedor: 'fake', modelo: 'fake-model', intentos: 2, referencia_id: second.autorizacion_id },
          clave_dedupe: `schema:${cliente.id}:smoke_test_pesado:${second.autorizacion_id}`,
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain(SECRETO);
      expect(notifier.enviados.map((e) => e.destinatarioUsuarioId)).toContain(staff.id);
    });
  });

  it('the vision alert uses the same sink; the legacy sink still receives the alert; an unrelated code stores nothing', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createCliente(db);
      const legacy: unknown[] = [];
      const sink = new PersistentAlertSink(runtime(db), { alert: async (a) => void legacy.push(a) });
      const referenceId = randomUUID();
      const alert = { code: 'vision_schema_invalid', clienteId: cliente.id, purpose: 'describir_media', provider: 'fake', model: 'fake-vision', attempts: 2, referenceId };
      await sink.alert(alert);
      await sink.alert(alert);
      expect(await codigosDe(db, cliente.id)).toEqual(['vision_schema_invalid']);
      await sink.alert({ ...alert, code: 'otro_codigo' });
      expect(await codigosDe(db, cliente.id)).toEqual(['vision_schema_invalid']);
      expect(legacy).toHaveLength(3);
    });
  });
});

describe('spend switches turned off', () => {
  it('the global switch off raises one global alert; turning it on raises nothing; the audit row still exists', async () => {
    await withTestTransaction(async (db) => {
      const admin = await createUsuarioConRol(db, 'administrador_novaciel');
      const actor = { tipo: 'usuario', usuarioId: admin.id } as const;
      const notifier = new FakeNotifier();
      await setGlobalSpendSwitch(db, false, actor, runtime(db, notifier));
      const { rows } = await db.query<{ cliente_id: string | null; severidad: string; parametros: { actualizado_en: string }; clave_dedupe: string }>(`SELECT cliente_id, severidad, parametros, clave_dedupe FROM alertas WHERE codigo = 'interruptor_global_apagado'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ cliente_id: null, severidad: 'critica' });
      expect(rows[0]!.clave_dedupe).toBe(`interruptor_global:${rows[0]!.parametros.actualizado_en}`);
      expect(notifier.enviados.length).toBeGreaterThan(0);
      // Off again changes nothing (it was already off): no second alert. On: no alert.
      await setGlobalSpendSwitch(db, false, actor, runtime(db, notifier));
      await setGlobalSpendSwitch(db, true, actor, runtime(db, notifier));
      expect((await db.query(`SELECT 1 FROM alertas WHERE codigo = 'interruptor_global_apagado'`)).rows).toHaveLength(1);
    });
  });

  it('the client switch off raises one alert of that client only; on raises none', async () => {
    await withTestTransaction(async (db) => {
      const admin = await createUsuarioConRol(db, 'administrador_novaciel');
      const actor = { tipo: 'usuario', usuarioId: admin.id } as const;
      const a = await createCliente(db);
      const b = await createCliente(db);
      await setClientSpendSwitch(db, asClienteId(a.id), false, actor, runtime(db));
      await setClientSpendSwitch(db, asClienteId(a.id), false, actor, runtime(db));
      expect(await codigosDe(db, a.id)).toEqual(['interruptor_cliente_apagado']);
      expect(await codigosDe(db, b.id)).toEqual([]);
      await setClientSpendSwitch(db, asClienteId(a.id), true, actor, runtime(db));
      expect(await codigosDe(db, a.id)).toEqual(['interruptor_cliente_apagado']);
    });
  });

  it('a refused change (not an administrator) raises nothing', async () => {
    await withTestTransaction(async (db) => {
      const operador = await createUsuarioConRol(db, 'operador_novaciel');
      await expect(setGlobalSpendSwitch(db, false, { tipo: 'usuario', usuarioId: operador.id }, runtime(db))).rejects.toThrow();
      expect((await db.query(`SELECT 1 FROM alertas WHERE codigo = 'interruptor_global_apagado'`)).rows).toHaveLength(0);
    });
  });
});

describe('quality control rejections', () => {
  it('an approved report raises nothing; a rejected one raises qc_rechazada once, with codes only', async () => {
    await withTestTransaction(async (db) => {
      const ok = await producibleWorld(db, { sinCifras: true });
      await producirPieza({ db, storage: ok.storage }, ok.clienteId, ok.piezaId, SISTEMA);
      const notifier = new FakeNotifier();
      const deps = { db, storage: ok.storage, alertas: runtime(db, notifier) };
      const { revision: aprobada } = await ejecutarQC(deps, ok.clienteId, ok.piezaId, SISTEMA);
      expect(aprobada.resultado).toBe('aprobado');
      expect(await codigosDe(db, ok.clienteId)).toEqual([]);

      const mal = await producibleWorld(db, { sinCifras: true });
      await producirPieza({ db, storage: mal.storage }, mal.clienteId, mal.piezaId, SISTEMA);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE guiones DISABLE TRIGGER USER');
      await db.query('SET CONSTRAINTS ALL DEFERRED');
      await db.query(`UPDATE guiones SET contenido = jsonb_set(contenido, '{escenas,0,texto_en_pantalla}', to_jsonb($2::text)) WHERE id = $1`, [mal.guionId, 'Fuego 🔥']);
      const { revision } = await ejecutarQC({ db, storage: mal.storage, alertas: runtime(db, notifier) }, mal.clienteId, mal.piezaId, SISTEMA);
      expect(revision.resultado).toBe('rechazado');
      const { rows } = await db.query<{ codigo: string; clave_dedupe: string; parametros: Record<string, unknown> }>('SELECT codigo, clave_dedupe, parametros FROM alertas WHERE cliente_id = $1 ORDER BY codigo', [mal.clienteId]);
      const produccion = (await getProduccionActual(db, mal.clienteId, mal.piezaId))!;
      expect(rows.map((r) => r.codigo)).toEqual(['capa_texto_fallo', 'qc_rechazada']);
      expect(rows.find((r) => r.codigo === 'qc_rechazada')).toMatchObject({ clave_dedupe: `qc:${revision.id}`, parametros: { pieza_id: mal.piezaId, revision_id: revision.id, codigos_fallo: revision.codigos_fallo } });
      expect(rows.find((r) => r.codigo === 'capa_texto_fallo')).toMatchObject({ clave_dedupe: `capa:${produccion.id}`, parametros: { codigos: ['marca_glifos_no_soportados'] } });
      expect(JSON.stringify(rows)).not.toContain('Fuego');
      // Other client untouched.
      expect(await codigosDe(db, ok.clienteId)).toEqual([]);
    });
  });

  it('fallosDeVozYCapa splits the failed codes into voice and text-layer failures', () => {
    expect(fallosDeVozYCapa(['cifra_libre', 'voz_audio_ausente', 'voz_volumen_fuera_de_rango', 'voz_subtitulos_ausentes', 'plantilla_invalida', 'marca_glifos_no_soportados'])).toEqual({
      voz: ['voz_audio_ausente', 'voz_volumen_fuera_de_rango'],
      capa: ['voz_subtitulos_ausentes', 'plantilla_invalida', 'marca_glifos_no_soportados'],
    });
    expect(fallosDeVozYCapa(['cifra_libre'])).toEqual({ voz: [], capa: [] });
  });
});
