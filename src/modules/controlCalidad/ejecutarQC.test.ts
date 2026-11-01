import { describe, expect, it } from 'vitest';
import sharp, { type Sharp } from 'sharp';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { createHechoVerificado, createPerfilMarca, createProduccion, createReglaProhibida, createUsuarioConRol, moverPieza } from '../../../tests/utils/factories/index.js';
import { producibleWorld, type ProducibleWorld } from '../../../tests/utils/produccionWorld.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { createLogger } from '../../lib/logger/index.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { SEED_PROFILE } from '../../scripts/seedProfile.js';
import { getHistorial, getPieza, PiezaNotFoundError } from '../piezas/index.js';
import { localDateTimeOf, minutesOf } from '../planificador/fechas.js';
import { getProduccionActual, producirPieza } from '../produccion/index.js';
import { ejecutarQC, MOTIVO_QC_APROBADO, MOTIVO_QC_NO_APROBADO, type QcDeps } from './ejecutarQC.js';
import { QcEstadoInvalidoError, QcProduccionCambioError, QcSinProduccionError } from './errors.js';
import { getUltimaRevision } from './revisionesRepository.js';
import type { CheckQC } from './tipos.js';

const SISTEMA = { tipo: 'sistema' } as const;
const SECRETO = 'SECRETO-DEL-CLIENTE-4471';

/** A carousel produced for real (images rendered and stored), waiting in en_control_calidad. */
async function producida(db: Db, opciones: Parameters<typeof producibleWorld>[1] = {}) {
  const w = await producibleWorld(db, { sinCifras: true, ...opciones });
  const { produccion } = await producirPieza({ db, storage: w.storage }, w.clienteId, w.piezaId, SISTEMA);
  return { w, produccion, deps: { db, storage: w.storage } satisfies QcDeps };
}

/** Disables the immutability of productions and briefs for the rest of the test transaction (the rollback restores it). */
async function sinInmutabilidad(db: Db) {
  await db.query('SET CONSTRAINTS ALL IMMEDIATE');
  await db.query('ALTER TABLE producciones DISABLE TRIGGER producciones_before_update_delete');
  await db.query('ALTER TABLE guiones DISABLE TRIGGER USER');
  await db.query('SET CONSTRAINTS ALL DEFERRED'); // the checks that wait for the end of a production must wait again
}

const codigos = (checks: { codigo: string; resultado: string }[], resultado = 'no_pasa') => checks.filter((c) => c.resultado === resultado).map((c) => c.codigo);
const por = (checks: CheckQC[], codigo: string) => checks.find((c) => c.codigo === codigo)!;
const estadoDe = async (db: Db, w: ProducibleWorld) => (await getPieza(db, w.clienteId, w.piezaId))!.estado;
const contar = async (db: Db, w: ProducibleWorld) => Number((await db.query('SELECT count(*) AS n FROM revisiones_calidad WHERE cliente_id = $1', [w.clienteId])).rows[0].n);

/** A new profile version for the client; the previous one is closed first (it is the only edit allowed). */
async function nuevaVersionDelPerfil(db: Db, w: ProducibleWorld, bloques: Record<string, unknown>) {
  await db.query('UPDATE perfil_marca SET es_actual = false WHERE cliente_id = $1 AND es_actual', [w.clienteId]);
  return createPerfilMarca(db, { clienteId: w.clienteId, ...bloques });
}

describe('ejecutarQC: a good carousel', () => {
  it('passes: the piece moves to revision_novaciel with a report bound to the exact production, audited, with no failed code', async () => {
    await withTestTransaction(async (db) => {
      const { w, produccion, deps } = await producida(db);
      expect(await estadoDe(db, w)).toBe('en_control_calidad');
      const { revision, pieza } = await ejecutarQC(deps, w.clienteId, w.piezaId, SISTEMA);

      expect(pieza.estado).toBe('revision_novaciel');
      expect(revision).toMatchObject({
        pieza_id: w.piezaId,
        produccion_id: produccion.id,
        produccion_version: 1,
        hash_version: 'np1',
        hash_pieza: produccion.hash_pieza,
        resultado: 'aprobado',
        codigos_fallo: [],
        actor_tipo: 'sistema',
      });
      expect(codigos(revision.checks)).toEqual([]);
      // Every family was evaluated.
      for (const codigo of ['archivo_hash_distinto', 'hash_pieza_distinto', 'imagen_formato', 'imagen_dimensiones', 'imagen_no_srgb', 'imagen_metadatos', 'imagen_tamano_maximo', 'texto_publicacion_largo', 'regla_prohibida_palabra', 'cifra_libre', 'hecho_no_vigente', 'fecha_pasada', 'horario_vetado', 'marca_contraste', 'media_no_usable', 'fuente_ia_no_permitida', 'toma_faltante']) {
        expect(por(revision.checks, codigo), codigo).toMatchObject({ resultado: 'pasa' });
      }
      expect(por(revision.checks, 'marca_contraste').parametros).toMatchObject({ perfil_marca_id: w.perfilId, perfil_origen: 'produccion' });

      const historial = (await getHistorial(db, w.clienteId, w.piezaId)).slice(-1)[0]!;
      expect(historial).toMatchObject({ desde: 'en_control_calidad', hacia: 'revision_novaciel', motivo: MOTIVO_QC_APROBADO });
      expect(await getUltimaRevision(db, w.clienteId, produccion.id)).toMatchObject({ id: revision.id });
      const auditoria = await auditRowsFor(db, 'revisiones_calidad', revision.id);
      expect(auditoria).toHaveLength(1);
      expect(auditoria[0]).toMatchObject({ accion: 'controlar_calidad', cliente_id: w.clienteId });
      expect(auditoria[0]!.datos_despues).toMatchObject({ resultado: 'aprobado', codigos_fallo: [], produccion_id: produccion.id, version: 1 });
    });
  });

  it('records the user who ran it', async () => {
    await withTestTransaction(async (db) => {
      const { w, deps } = await producida(db);
      const staff = await createUsuarioConRol(db, 'operador_novaciel');
      const { revision } = await ejecutarQC(deps, w.clienteId, w.piezaId, { tipo: 'usuario', usuarioId: staff.id });
      expect(revision).toMatchObject({ actor_tipo: 'usuario', actor_usuario_id: staff.id });
    });
  });
});

describe('ejecutarQC: a failing carousel goes back to en_produccion with the failed code', () => {
  /** Runs QC after `cambiar` and expects the piece back in production with exactly these codes among the failures. */
  async function rechaza(esperados: string[], cambiar: (ctx: Awaited<ReturnType<typeof producida>> & { db: Db }) => Promise<Partial<QcDeps> | void>, opciones: Parameters<typeof producibleWorld>[1] = {}) {
    await withTestTransaction(async (db) => {
      const ctx = { ...(await producida(db, opciones)), db };
      const extra = (await cambiar(ctx)) ?? {};
      const { w } = ctx;
      const { revision, pieza } = await ejecutarQC({ ...ctx.deps, ...extra }, w.clienteId, w.piezaId, SISTEMA);
      expect(revision.resultado).toBe('rechazado');
      for (const esperado of esperados) expect(revision.codigos_fallo, esperado).toContain(esperado);
      expect(pieza.estado).toBe('en_produccion');
      const historial = (await getHistorial(db, w.clienteId, w.piezaId)).slice(-1)[0]!;
      expect(historial).toMatchObject({ desde: 'en_control_calidad', hacia: 'en_produccion', motivo: MOTIVO_QC_NO_APROBADO });
      // The failed code carries a fixed reason in Spanish and no text of the piece.
      for (const esperado of esperados) expect(por(revision.checks, esperado)).toMatchObject({ resultado: 'no_pasa', severidad: 'bloqueante' });
      expect(await estadoDe(db, w)).toBe('en_produccion');
    });
  }
  const claveDe = (ctx: Awaited<ReturnType<typeof producida>>, orden: number) => ctx.produccion.archivos.find((a) => a.orden === orden)!.clave_almacenamiento;
  const jpeg = (ancho: number, alto: number, ajuste?: (s: Sharp) => Sharp) => {
    const base = sharp({ create: { width: ancho, height: alto, channels: 3, background: { r: 10, g: 20, b: 30 } } });
    return (ajuste ? ajuste(base) : base).jpeg({ quality: 90 }).toBuffer();
  };

  it('archivo_ilegible: a stored file is missing', async () => {
    await rechaza(['archivo_ilegible', 'hash_pieza_distinto'], async (c) => void (await c.w.storage.delete(claveDe(c, 2))));
  });

  it('archivo_tamano_distinto and archivo_hash_distinto: the bytes of a file changed', async () => {
    await rechaza(['archivo_tamano_distinto', 'archivo_hash_distinto', 'hash_pieza_distinto'], async (c) => void (await c.w.storage.put(claveDe(c, 1), Buffer.from('otro contenido'))));
  });

  it('archivo_hash_distinto alone: same size, different bytes (the real image is still valid)', async () => {
    await rechaza(['archivo_hash_distinto', 'hash_pieza_distinto'], async (c) => {
      const actual = await c.w.storage.get(claveDe(c, 1));
      await c.w.storage.put(claveDe(c, 1), Buffer.concat([actual.subarray(0, actual.length - 1), Buffer.from([(actual[actual.length - 1]! + 1) % 256])]));
    });
  });

  it('hash_pieza_distinto: the stored piece hash does not match what is stored', async () => {
    await rechaza(['hash_pieza_distinto'], async (c) => {
      await sinInmutabilidad(c.db);
      await c.db.query("UPDATE producciones SET hash_pieza = decode(repeat('ab', 32), 'hex') WHERE id = $1", [c.produccion.id]);
    });
  });

  it('imagen_formato: the file is a PNG, not the JPEG recorded', async () => {
    await rechaza(['imagen_formato'], async (c) => void (await c.w.storage.put(claveDe(c, 1), await sharp({ create: { width: 1080, height: 1350, channels: 3, background: '#123456' } }).png().toBuffer())));
  });

  it('imagen_dimensiones: the image is not the size of the network and format', async () => {
    await rechaza(['imagen_dimensiones'], async (c) => void (await c.w.storage.put(claveDe(c, 1), await jpeg(1080, 1080))));
  });

  it('imagen_no_srgb: the image is not in sRGB', async () => {
    await rechaza(['imagen_no_srgb'], async (c) => void (await c.w.storage.put(claveDe(c, 1), await jpeg(1080, 1350, (s) => s.toColourspace('b-w')))));
  });

  it('imagen_metadatos: the image carries EXIF metadata', async () => {
    await rechaza(['imagen_metadatos'], async (c) => void (await c.w.storage.put(claveDe(c, 1), await jpeg(1080, 1350, (s) => s.withExif({ IFD0: { Copyright: 'Privado' } })))));
  });

  it('imagen_tamano_maximo: an image is over the size cap', async () => {
    await rechaza(['imagen_tamano_maximo'], async () => ({ maxImagenBytes: 100 }));
  });

  it.each([
    ['texto_publicacion_largo', 'UPDATE producciones SET texto_publicacion = repeat(\'a\', 2001) WHERE id = $1'],
    ['hashtags_cantidad', "UPDATE producciones SET hashtags = ARRAY['#a','#b','#c','#d','#e','#f','#g','#h','#i','#j','#k'] WHERE id = $1"],
    ['hashtags_forma', "UPDATE producciones SET hashtags = ARRAY['sin numeral'] WHERE id = $1"],
    ['texto_alternativo_largo', "UPDATE producciones SET textos_alternativos = ARRAY[repeat('a', 101), 'b', 'c', 'd', 'e'] WHERE id = $1"],
    ['texto_alternativo_falta', "UPDATE producciones SET textos_alternativos = ARRAY['a', '', 'c', 'd', 'e'] WHERE id = $1"],
    ['ubicacion_larga', "UPDATE producciones SET ubicacion = repeat('u', 101) WHERE id = $1"],
    ['cifra_libre', "UPDATE producciones SET texto_publicacion = 'Hoy el café cuesta $5' WHERE id = $1"],
  ])('%s: the stored copy breaks the rule', async (codigo, sql) => {
    await rechaza([codigo], async (c) => {
      await sinInmutabilidad(c.db);
      await c.db.query(sql, [c.produccion.id]);
    });
  });

  it('diapositivas_cantidad: a carousel with fewer slides than allowed', async () => {
    await rechaza(['diapositivas_cantidad'], async () => undefined, { slides: 4 });
  });

  it('regla_prohibida_palabra, regla_prohibida_promesa and regla_prohibida_tema: the banned rules of the client', async () => {
    await rechaza(['regla_prohibida_palabra', 'regla_prohibida_promesa', 'regla_prohibida_tema'], async (c) => {
      await createReglaProhibida(c.db, { clienteId: c.w.clienteId, tipo: 'palabra', texto: 'ORIGEN' }); // on-screen text, ignoring case
      await createReglaProhibida(c.db, { clienteId: c.w.clienteId, tipo: 'promesa', texto: 'hecho con calma' });
      await createReglaProhibida(c.db, { clienteId: c.w.clienteId, tipo: 'tema', texto: 'barrio' });
    });
  });

  it('hecho_texto_cambiado: a cited fact was edited after the piece was written', async () => {
    await rechaza(['hecho_texto_cambiado', 'cifra_libre'], async (c) => {
      const hecho = await createHechoVerificado(c.db, { clienteId: c.w.clienteId, tipo: 'precio', enunciado: 'El café cuesta $5' });
      await sinInmutabilidad(c.db);
      await c.db.query(
        `UPDATE guiones SET contenido_modelo = jsonb_set(contenido_modelo, '{texto_publicacion,texto}', to_jsonb($2::text)) WHERE id = $1`,
        [c.w.guionId, `Hoy: {{hecho:${hecho.id}}}`],
      );
      await c.db.query('UPDATE producciones SET texto_publicacion = $2 WHERE id = $1', [c.produccion.id, 'Hoy: El café cuesta $5']);
      await c.db.query("UPDATE hechos_verificados SET enunciado = 'El café cuesta $6' WHERE id = $1", [hecho.id]);
    });
  });

  it('hecho_no_vigente: a cited fact is no longer valid', async () => {
    await rechaza(['hecho_no_vigente'], async (c) => {
      const hecho = await createHechoVerificado(c.db, { clienteId: c.w.clienteId, tipo: 'precio', enunciado: 'El café cuesta $5', expired: true });
      await sinInmutabilidad(c.db);
      await c.db.query(
        `UPDATE guiones SET contenido_modelo = jsonb_set(contenido_modelo, '{texto_publicacion,texto}', to_jsonb($2::text)) WHERE id = $1`,
        [c.w.guionId, `Hoy: {{hecho:${hecho.id}}}`],
      );
      await c.db.query('UPDATE producciones SET texto_publicacion = $2 WHERE id = $1', [c.produccion.id, 'Hoy: El café cuesta $5']);
    });
  });

  it('media_no_usable: a source was deleted', async () => {
    await rechaza(['media_no_usable'], async (c) => void (await c.db.query('UPDATE media SET eliminado_en = now() WHERE id = $1', [c.w.media[0]!.id])));
  });

  it('fecha_pasada: the publication date is already past', async () => {
    await rechaza(['fecha_pasada'], async () => ({ now: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }));
  });

  it('horario_vetado: the publication hour is vetoed by the current profile', async () => {
    await rechaza(['horario_vetado'], async (c) => {
      const pieza = (await getPieza(c.db, c.w.clienteId, c.w.piezaId))!;
      const zona = (await c.db.query<{ zona_horaria: string }>('SELECT zona_horaria FROM planes_semanales WHERE id = $1', [c.w.planId])).rows[0]!.zona_horaria;
      const minuto = minutesOf(localDateTimeOf(pieza.fecha_hora, zona).hora);
      const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const desde = Math.max(0, minuto - 1);
      const hasta = Math.min(24 * 60 - 1, minuto + 1);
      await nuevaVersionDelPerfil(c.db, c.w, { kit_visual: structuredClone(SEED_PROFILE.kit_visual), operacion: { horarios_vetados: [{ desde: fmt(desde), hasta: fmt(Math.max(hasta, desde + 1)) }] } });
    });
  });

  it('marca_glifos_no_soportados: an on-screen text has characters the font cannot draw', async () => {
    await rechaza(['marca_glifos_no_soportados'], async (c) => {
      await sinInmutabilidad(c.db);
      await c.db.query(
        `UPDATE guiones SET contenido = jsonb_set(contenido, '{escenas,0,texto_en_pantalla}', to_jsonb($2::text)) WHERE id = $1`,
        [c.w.guionId, 'Fuego 🔥'],
      );
    });
  });
});

describe('ejecutarQC: codes that the database cannot produce today pass in a healthy run', () => {
  it('fuente_ia_no_permitida and toma_faltante pass, with the media of the library', async () => {
    await withTestTransaction(async (db) => {
      const { w, deps } = await producida(db);
      const { revision } = await ejecutarQC(deps, w.clienteId, w.piezaId, SISTEMA);
      expect(por(revision.checks, 'fuente_ia_no_permitida').resultado).toBe('pasa');
      expect(por(revision.checks, 'toma_faltante').resultado).toBe('pasa');
    });
  });
});

describe('ejecutarQC: the brand profile of the production', () => {
  it('a kit edited AFTER production does not change the result: the profile version the files were made with is judged', async () => {
    await withTestTransaction(async (db) => {
      const { w, produccion, deps } = await producida(db);
      expect((await getProduccionActual(db, w.clienteId, w.piezaId))!.perfil_marca_id).toBe(w.perfilId);
      // The kit loses every colour after the production was rendered.
      const nueva = await nuevaVersionDelPerfil(db, w, { kit_visual: {} });
      const { revision } = await ejecutarQC(deps, w.clienteId, w.piezaId, SISTEMA);
      expect(revision.produccion_id).toBe(produccion.id);
      expect(revision.resultado).toBe('aprobado');
      expect(por(revision.checks, 'marca_colores_respaldo')).toMatchObject({ resultado: 'pasa', parametros: { perfil_marca_id: w.perfilId, perfil_origen: 'produccion' } });
      expect(JSON.stringify(revision.checks)).not.toContain(nueva.id);
    });
  });

  it('the opposite also holds: a poor kit at production time stays poor even if the kit improves later', async () => {
    await withTestTransaction(async (db) => {
      const base = await producibleWorld(db, { sinCifras: true });
      await nuevaVersionDelPerfil(db, base, { kit_visual: {} }); // current profile at production time has no colours
      const pobre = await db.query<{ id: string }>('SELECT id FROM perfil_marca WHERE cliente_id = $1 AND es_actual', [base.clienteId]);
      await producirPieza({ db, storage: base.storage }, base.clienteId, base.piezaId, SISTEMA);
      await nuevaVersionDelPerfil(db, base, { kit_visual: structuredClone(SEED_PROFILE.kit_visual) });
      const { revision } = await ejecutarQC({ db, storage: base.storage }, base.clienteId, base.piezaId, SISTEMA);
      expect(por(revision.checks, 'marca_colores_respaldo')).toMatchObject({ resultado: 'advertencia', parametros: { perfil_marca_id: pobre.rows[0]!.id, perfil_origen: 'produccion' } });
      expect(revision.resultado).toBe('aprobado'); // a warning never rejects
    });
  });

  it('a production made before the profile was recorded (NULL) falls back to the profile of the brief', async () => {
    await withTestTransaction(async (db) => {
      const { w, produccion, deps } = await producida(db);
      await sinInmutabilidad(db);
      await db.query('UPDATE producciones SET perfil_marca_id = NULL WHERE id = $1', [produccion.id]);
      const { revision } = await ejecutarQC(deps, w.clienteId, w.piezaId, SISTEMA);
      expect(por(revision.checks, 'marca_contraste').parametros).toMatchObject({ perfil_marca_id: w.perfilId, perfil_origen: 'brief' });
    });
  });
});

describe('ejecutarQC: refusals and races', () => {
  it('a production replaced while the checks run: nothing is stored and the piece does not move', async () => {
    await withTestTransaction(async (db) => {
      const { w, produccion } = await producida(db);
      let reemplazada = false;
      class Envoltorio extends FakeStorage {}
      const storage = new Envoltorio();
      // The same files, but the first read creates the next version of the production, like another worker would.
      for (const archivo of produccion.archivos) await storage.put(archivo.clave_almacenamiento, await w.storage.get(archivo.clave_almacenamiento));
      const original = storage.getFile.bind(storage);
      storage.getFile = async (key: string, destino: string) => {
        if (!reemplazada) {
          reemplazada = true;
          await createProduccion(db, { piezaId: w.piezaId });
        }
        return original(key, destino);
      };
      await expect(ejecutarQC({ db, storage }, w.clienteId, w.piezaId, SISTEMA)).rejects.toBeInstanceOf(QcProduccionCambioError);
      expect(await contar(db, w)).toBe(0);
      expect(await estadoDe(db, w)).toBe('en_control_calidad');
      expect((await auditRowsFor(db, 'revisiones_calidad', produccion.id)).length).toBe(0);
    });
  });

  it('a second run after the first one finished: the piece is not waiting for QC any more', async () => {
    await withTestTransaction(async (db) => {
      const { w, deps } = await producida(db);
      await ejecutarQC(deps, w.clienteId, w.piezaId, SISTEMA);
      await expect(ejecutarQC(deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toMatchObject({ name: 'QcEstadoInvalidoError', estado: 'revision_novaciel' });
      expect(await contar(db, w)).toBe(1);
    });
  });

  it('refuses a piece that is not in en_control_calidad, a piece with no production, and an unknown piece', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db, { sinCifras: true });
      await expect(ejecutarQC({ db, storage: w.storage }, w.clienteId, w.piezaId, SISTEMA)).rejects.toBeInstanceOf(QcEstadoInvalidoError); // guion_listo
      await expect(ejecutarQC({ db, storage: w.storage }, w.clienteId, '123e4567-e89b-42d3-a456-426614174000', SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      const sin = await producibleWorld(db, { sinCifras: true });
      await moverPieza(db, sin.piezaId, 'en_produccion');
      await moverPieza(db, sin.piezaId, 'en_control_calidad');
      await expect(ejecutarQC({ db, storage: sin.storage }, sin.clienteId, sin.piezaId, SISTEMA)).rejects.toBeInstanceOf(QcSinProduccionError);
    });
  });

  it("another client's piece is not reachable: not found, nothing stored, the other client unchanged", async () => {
    await withTestTransaction(async (db) => {
      const a = await producida(db);
      const b = await producida(db);
      await expect(ejecutarQC(b.deps, b.w.clienteId, a.w.piezaId, SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(await contar(db, a.w)).toBe(0);
      expect(await contar(db, b.w)).toBe(0);
      expect(await estadoDe(db, a.w)).toBe('en_control_calidad');
    });
  });
});

describe('ejecutarQC: no text of the client leaves the piece', () => {
  it('logs, the audit row and the report hold no text of the copy, even when the checks fail', async () => {
    await withTestTransaction(async (db) => {
      const { w, produccion, deps } = await producida(db);
      await sinInmutabilidad(db);
      await db.query('UPDATE producciones SET texto_publicacion = $2, hashtags = ARRAY[$3], ubicacion = $4 WHERE id = $1', [
        produccion.id,
        `Hoy ${SECRETO} cuesta $5`,
        `#${SECRETO}`,
        `Lugar ${SECRETO}`,
      ]);
      await createReglaProhibida(db, { clienteId: w.clienteId, tipo: 'palabra', texto: 'cuesta' });
      const lineas: string[] = [];
      const logger = createLogger('debug', { write: (l: string) => void lineas.push(l) });
      const { revision } = await ejecutarQC({ ...deps, logger }, w.clienteId, w.piezaId, SISTEMA);
      expect(revision.resultado).toBe('rechazado');
      expect(lineas.join('')).toContain('quality control finished');
      expect(lineas.join('')).not.toContain(SECRETO);
      expect(JSON.stringify(revision)).not.toContain(SECRETO);
      expect(JSON.stringify(await auditRowsFor(db, 'revisiones_calidad', revision.id))).not.toContain(SECRETO);
      const guardado = await db.query('SELECT checks::text AS checks FROM revisiones_calidad WHERE id = $1', [revision.id]);
      expect(guardado.rows[0].checks).not.toContain(SECRETO);
    });
  });
});

describe('ejecutarQC: reports of earlier runs', () => {
  it('a rejected run leaves a rejected report and the piece back in production; a new production is controlled on its own', async () => {
    await withTestTransaction(async (db) => {
      const { w, produccion, deps } = await producida(db);
      await sinInmutabilidad(db);
      await db.query("UPDATE producciones SET hashtags = ARRAY['sin numeral'] WHERE id = $1", [produccion.id]);
      const primero = await ejecutarQC(deps, w.clienteId, w.piezaId, SISTEMA);
      expect(primero.revision.resultado).toBe('rechazado');
      // Producing again makes version 2; its report is independent of the first one.
      const { produccion: v2 } = await producirPieza({ db, storage: w.storage }, w.clienteId, w.piezaId, SISTEMA, { reproducir: true });
      expect(v2.version).toBe(2);
      const segundo = await ejecutarQC(deps, w.clienteId, w.piezaId, SISTEMA);
      expect(segundo.revision).toMatchObject({ produccion_id: v2.id, produccion_version: 2, resultado: 'aprobado' });
      expect((await getUltimaRevision(db, w.clienteId, produccion.id))!.id).toBe(primero.revision.id);
    });
  });
});
