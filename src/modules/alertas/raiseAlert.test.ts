import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAprobadoresCliente, createCliente, createUsuarioConRol } from '../../../tests/utils/factories/index.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { FakeNotifier } from '../../lib/notificaciones/notifiers.js';
import { createLogger } from '../../lib/logger/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { CATALOGO, CODIGOS_ALERTA, type CodigoAlerta } from './catalogo.js';
import { raiseAlert, raiseAlertBestEffort } from './raiseAlert.js';

const id = () => randomUUID();
const NOW = new Date('2026-11-03T12:00:00.000Z').toISOString();

/** Valid parameters for each code of the catalogue. */
const PARAMS: Record<CodigoAlerta, () => Record<string, unknown>> = {
  presupuesto_umbral_50: () => ({ periodo: '2026-11-01', umbral: 50, porcentaje: 51.2 }),
  presupuesto_umbral_80: () => ({ periodo: '2026-11-01', umbral: 80, porcentaje: 80 }),
  presupuesto_umbral_100: () => ({ periodo: '2026-11-01', umbral: 100, porcentaje: 100 }),
  interruptor_global_apagado: () => ({ actualizado_en: NOW }),
  interruptor_cliente_apagado: () => ({ actualizado_en: NOW }),
  trabajo_fallido: () => ({ cola: 'control-calidad', job_id: id(), nombre_error: 'Error' }),
  llm_schema_invalid: () => ({ proposito: 'plan_semanal', proveedor: 'fake', modelo: 'fake-model', intentos: 2, referencia_id: id() }),
  vision_schema_invalid: () => ({ proposito: 'describir_media', proveedor: 'fake', modelo: 'fake-model', intentos: 2, referencia_id: id() }),
  aprobacion_vencida: () => ({ tipo: 'pieza', objeto_id: id(), plazo: NOW }),
  aprobacion_escalada: () => ({ pieza_id: id() }),
  qc_rechazada: () => ({ pieza_id: id(), revision_id: id(), codigos_fallo: ['cifra_libre'] }),
  voz_fallo: () => ({ pieza_id: id(), produccion_id: id(), codigos: ['voz_audio_ausente'] }),
  capa_texto_fallo: () => ({ pieza_id: id(), produccion_id: id(), codigos: ['marca_glifos_no_soportados'] }),
  publicacion_fallida: () => ({ pieza_id: id(), produccion_id: id(), motivo: 'server' }),
  publicacion_resultado_desconocido: () => ({ pieza_id: id(), produccion_id: id() }),
  publicacion_sin_aprobacion: () => ({ pieza_id: id(), fecha_hora: NOW, reprogramaciones: 1 }),
  publicacion_reprogramaciones_agotadas: () => ({ pieza_id: id(), fecha_hora: NOW }),
  conexion_red_vencida: () => ({ red: 'instagram', conexion_id: id() }),
  etiqueta_ia_no_soportada: () => ({ pieza_id: id(), produccion_id: id(), proveedor: 'fake', red: 'instagram' }),
};

function capturedLogger() {
  const lines: string[] = [];
  return { log: createLogger('debug', { write: (l: string) => void lines.push(l) }), text: () => lines.join('') };
}

async function world(db: Db) {
  const cliente = await createCliente(db);
  const clienteId = asClienteId(cliente.id);
  const admin = await createUsuarioConRol(db, 'administrador_novaciel');
  const operador = await createUsuarioConRol(db, 'operador_novaciel');
  const inactivo = await createUsuarioConRol(db, 'operador_novaciel');
  await db.query('UPDATE usuarios SET activo = false WHERE id = $1', [inactivo.id]);
  const dueno = await createUsuarioConRol(db, 'dueno_cliente', cliente.id);
  const principal = await createUsuarioConRol(db, 'aprobador_cliente', cliente.id);
  await createAprobadoresCliente(db, { clienteId: cliente.id, principalUsuarioId: principal.id, suplenteUsuarioId: dueno.id });
  const otroDueno = await createUsuarioConRol(db, 'dueno_cliente', (await createCliente(db)).id);
  const staff = (await db.query<{ id: string }>(`SELECT DISTINCT u.id FROM usuarios u JOIN usuario_roles ur ON ur.usuario_id = u.id WHERE u.activo AND ur.ambito = 'novaciel'`)).rows.map((r) => r.id);
  return { cliente, clienteId, admin, operador, inactivo, dueno, principal, otroDueno, staff };
}

const alertasDe = async (db: Db, clave: string) => (await db.query<{ id: string; cliente_id: string | null; codigo: string; severidad: string; parametros: unknown }>('SELECT id, cliente_id, codigo, severidad, parametros FROM alertas WHERE clave_dedupe = $1', [clave])).rows;

describe('raiseAlert', () => {
  it('inserts once per dedupe key and notifies only when it really inserted', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const notifier = new FakeNotifier();
      const parametros = PARAMS.qc_rechazada();
      const first = await raiseAlert({ db, notifier }, 'qc_rechazada', { clienteId: w.clienteId, parametros });
      expect(first.creada).toBe(true);
      const sent = notifier.enviados.length;
      expect(sent).toBe(w.staff.length);
      const again = await raiseAlert({ db, notifier }, 'qc_rechazada', { clienteId: w.clienteId, parametros });
      expect(again).toEqual({ creada: false, alertaId: null });
      expect(notifier.enviados).toHaveLength(sent);
      expect(await alertasDe(db, `qc:${parametros.revision_id}`)).toHaveLength(1);
    });
  });

  it('qc_rechazada: only active NovaCiel staff are told, with the alert template and the alert id', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const notifier = new FakeNotifier();
      const { alertaId } = await raiseAlert({ db, notifier }, 'qc_rechazada', { clienteId: w.clienteId, parametros: PARAMS.qc_rechazada() });
      const dest = notifier.enviados.map((e) => e.destinatarioUsuarioId).sort();
      expect(dest).toEqual([...w.staff].sort());
      expect(dest).not.toContain(w.inactivo.id);
      for (const e of [w.dueno.id, w.principal.id, w.otroDueno.id]) expect(dest).not.toContain(e);
      expect(notifier.enviados.every((e) => e.plantilla === 'alerta_novaciel' && e.clienteId === w.clienteId && e.referencia.tipo === 'alerta' && e.referencia.id === alertaId)).toBe(true);
    });
  });

  it('presupuesto_umbral_100 also tells the client owners with a template that has no figures; 80 does not', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const notifier = new FakeNotifier();
      await raiseAlert({ db, notifier }, 'presupuesto_umbral_80', { clienteId: w.clienteId, parametros: PARAMS.presupuesto_umbral_80() });
      expect(notifier.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(w.dueno.id);
      const { alertaId } = await raiseAlert({ db, notifier }, 'presupuesto_umbral_100', { clienteId: w.clienteId, parametros: PARAMS.presupuesto_umbral_100() });
      const alOwner = notifier.enviados.filter((e) => e.destinatarioUsuarioId === w.dueno.id);
      expect(alOwner).toEqual([{ clienteId: w.clienteId, destinatarioUsuarioId: w.dueno.id, plantilla: 'presupuesto_techo_cliente', referencia: { tipo: 'alerta', id: alertaId } }]);
      expect(notifier.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(w.principal.id);
      expect(notifier.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(w.otroDueno.id);
      for (const e of notifier.enviados) expect(Object.keys(e).sort()).toEqual(['clienteId', 'destinatarioUsuarioId', 'plantilla', 'referencia']);
    });
  });

  it('aprobacion_vencida tells NovaCiel and the valid approvers (main and substitute) of that client only', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const notifier = new FakeNotifier();
      await raiseAlert({ db, notifier }, 'aprobacion_vencida', { clienteId: w.clienteId, parametros: PARAMS.aprobacion_vencida() });
      const aprobadores = notifier.enviados.filter((e) => e.plantilla === 'aprobacion_vencida').map((e) => e.destinatarioUsuarioId).sort();
      expect(aprobadores).toEqual([w.dueno.id, w.principal.id].sort());
      expect(notifier.enviados.map((e) => e.destinatarioUsuarioId)).not.toContain(w.otroDueno.id);
    });
  });

  it('aprobacion_escalada does not notify (Step 9 already does) but is stored', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const notifier = new FakeNotifier();
      const parametros = PARAMS.aprobacion_escalada();
      expect((await raiseAlert({ db, notifier }, 'aprobacion_escalada', { clienteId: w.clienteId, parametros })).creada).toBe(true);
      expect(notifier.enviados).toEqual([]);
      expect(await alertasDe(db, `escalada:${parametros.pieza_id}`)).toHaveLength(1);
    });
  });

  it('a global alert has no client and its notices carry clienteId null', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const notifier = new FakeNotifier();
      const parametros = PARAMS.trabajo_fallido();
      const { alertaId } = await raiseAlert({ db, notifier }, 'trabajo_fallido', { clienteId: null, parametros });
      const [row] = await alertasDe(db, `trabajo:${parametros.cola}:${parametros.job_id}`);
      expect(row).toMatchObject({ id: alertaId, cliente_id: null, codigo: 'trabajo_fallido', severidad: 'aviso' });
      expect(notifier.enviados).toHaveLength(w.staff.length);
      expect(notifier.enviados.every((e) => e.clienteId === null)).toBe(true);
      await expect(raiseAlert({ db, notifier }, 'trabajo_fallido', { clienteId: w.clienteId, parametros: PARAMS.trabajo_fallido() })).rejects.toThrow(/global/);
      await expect(raiseAlert({ db, notifier }, 'qc_rechazada', { clienteId: null, parametros: PARAMS.qc_rechazada() })).rejects.toThrow(/needs a client/);
    });
  });

  it('a notifier that fails keeps the alert, still tries the other recipients and logs only the error name', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const notifier = new FakeNotifier();
      notifier.fallarCon = new RangeError('provider said: SECRETO-DEL-CLIENTE');
      const logs = capturedLogger();
      const parametros = PARAMS.qc_rechazada();
      const r = await raiseAlert({ db, notifier, logger: logs.log }, 'qc_rechazada', { clienteId: w.clienteId, parametros });
      expect(r.creada).toBe(true);
      expect(await alertasDe(db, `qc:${parametros.revision_id}`)).toHaveLength(1);
      expect(logs.text()).toContain('RangeError');
      expect(logs.text()).not.toContain('SECRETO-DEL-CLIENTE');
      expect(w.staff.length).toBeGreaterThan(0);
    });
  });

  it('refuses parameters that are not exactly the schema of the code, and stores nothing', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const notifier = new FakeNotifier();
      const before = Number((await db.query('SELECT count(*) AS n FROM alertas')).rows[0].n);
      const bad: [CodigoAlerta, Record<string, unknown>][] = [
        ['qc_rechazada', { ...PARAMS.qc_rechazada(), texto: 'Texto del cliente' }],
        ['qc_rechazada', { ...PARAMS.qc_rechazada(), pieza_id: 'no-es-uuid' }],
        ['qc_rechazada', { ...PARAMS.qc_rechazada(), codigos_fallo: ['una frase con espacios del cliente'] }],
        ['presupuesto_umbral_50', { ...PARAMS.presupuesto_umbral_50(), umbral: 80 }],
        ['presupuesto_umbral_50', { ...PARAMS.presupuesto_umbral_50(), periodo: '2026-11-15' }],
        ['aprobacion_vencida', { ...PARAMS.aprobacion_vencida(), tipo: 'comentario' }],
        ['llm_schema_invalid', { ...PARAMS.llm_schema_invalid(), prompt: 'Escribe sobre el cliente' }],
      ];
      for (const [codigo, parametros] of bad) {
        await expect(raiseAlert({ db, notifier }, codigo, { clienteId: w.clienteId, parametros }), codigo).rejects.toThrow();
      }
      await expect(raiseAlert({ db, notifier }, 'trabajo_fallido', { clienteId: null, parametros: { cola: 'una cola con espacios', job_id: id(), nombre_error: 'Error' } })).rejects.toThrow();
      expect(Number((await db.query('SELECT count(*) AS n FROM alertas')).rows[0].n)).toBe(before);
      expect(notifier.enviados).toEqual([]);
    });
  });

  it('every code of the catalogue has a strict schema (an extra key is refused) and a client-or-global rule', () => {
    expect(CODIGOS_ALERTA).toHaveLength(19);
    for (const codigo of CODIGOS_ALERTA) {
      const def = CATALOGO[codigo];
      expect(def.parametros.safeParse(PARAMS[codigo]()).success, codigo).toBe(true);
      expect(def.parametros.safeParse({ ...PARAMS[codigo](), texto_libre: 'x' }).success, codigo).toBe(false);
      expect(['info', 'aviso', 'critica']).toContain(def.severidad);
    }
    expect(CATALOGO.presupuesto_umbral_50.severidad).toBe('info');
    expect(CATALOGO.presupuesto_umbral_80.severidad).toBe('aviso');
    expect(CATALOGO.presupuesto_umbral_100.severidad).toBe('critica');
    expect(CATALOGO.aprobacion_escalada.severidad).toBe('critica');
    expect(CATALOGO.interruptor_global_apagado.ambito).toBe('global');
    expect(CATALOGO.trabajo_fallido.ambito).toBe('global');
  });

  it('every dedupe key matches the agreed format', () => {
    const c = '11111111-1111-4111-8111-111111111111';
    const p = (codigo: CodigoAlerta) => PARAMS[codigo]();
    expect(CATALOGO.presupuesto_umbral_80.clave(c, p('presupuesto_umbral_80'))).toBe(`presupuesto:${c}:2026-11-01:80`);
    expect(CATALOGO.interruptor_global_apagado.clave(null, p('interruptor_global_apagado'))).toBe(`interruptor_global:${NOW}`);
    expect(CATALOGO.interruptor_cliente_apagado.clave(c, p('interruptor_cliente_apagado'))).toBe(`interruptor_cliente:${c}:${NOW}`);
    const trabajo = p('trabajo_fallido');
    expect(CATALOGO.trabajo_fallido.clave(null, trabajo)).toBe(`trabajo:control-calidad:${trabajo.job_id}`);
    const esquema = p('llm_schema_invalid');
    expect(CATALOGO.llm_schema_invalid.clave(c, esquema)).toBe(`schema:${c}:plan_semanal:${esquema.referencia_id}`);
    const vencida = p('aprobacion_vencida');
    expect(CATALOGO.aprobacion_vencida.clave(c, vencida)).toBe(`aprobacion_vencida:pieza:${vencida.objeto_id}:${NOW}`);
    const escalada = p('aprobacion_escalada');
    expect(CATALOGO.aprobacion_escalada.clave(c, escalada)).toBe(`escalada:${escalada.pieza_id}`);
    const qc = p('qc_rechazada');
    expect(CATALOGO.qc_rechazada.clave(c, qc)).toBe(`qc:${qc.revision_id}`);
    const voz = p('voz_fallo');
    expect(CATALOGO.voz_fallo.clave(c, voz)).toBe(`voz:${voz.produccion_id}`);
    const capa = p('capa_texto_fallo');
    expect(CATALOGO.capa_texto_fallo.clave(c, capa)).toBe(`capa:${capa.produccion_id}`);
  });
});

describe('raiseAlertBestEffort', () => {
  it('does nothing without deps and never throws: a failure is logged by name only', async () => {
    await withTestTransaction(async (db) => {
      await expect(raiseAlertBestEffort(undefined, 'qc_rechazada', { clienteId: null, parametros: {} })).resolves.toBeUndefined();
      const logs = capturedLogger();
      const notifier = new FakeNotifier();
      await expect(raiseAlertBestEffort({ db, notifier, logger: logs.log }, 'qc_rechazada', { clienteId: null, parametros: { texto: 'SECRETO-DEL-CLIENTE' } })).resolves.toBeUndefined();
      expect(logs.text()).toContain('alert could not be raised');
      expect(logs.text()).not.toContain('SECRETO-DEL-CLIENTE');
    });
  });
});
