import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import { createCliente, createGuion, createMedia, createMediaAutorizacion, createPieza, createPiezaHecho, createPlanSemanal, moverPieza } from '../../../tests/utils/factories/index.js';
import { FakeLLMProvider } from '../../lib/ai/fakeLLMProvider.js';
import { SchemaValidationError } from '../ai/generateStructured.js';
import { getHistorial, getPieza, PiezaNotFoundError, PlanDescartadoError, pausarPieza } from '../piezas/index.js';
import { aprobarPlanInterno, PlanNoAprobadoError } from '../planificador/index.js';
import { microToUsd } from '../presupuesto/money.js';
import { BudgetRefusedError } from '../presupuesto/presupuestoService.js';
import { asClienteId } from '../shared/clienteId.js';
import { BRIEF_PURPOSE, generarBrief, generarBriefsDelPlan, maxOutputTokensFor } from './directorService.js';
import { BriefExistenteError, BriefHechoVencidoError, BriefMediaNoUsableError, BriefObsoletoError, PiezaEstadoInvalidoError } from './errors.js';
import { getBriefActual, listBriefVersions } from './guionesRepository.js';
import { factToken } from './tokens.js';
import { briefJson, countRows, ledger, piece, ProviderWithSideEffect, SECRET_TEXTS, world } from '../../../tests/utils/directorWorld.js';

const SISTEMA = { tipo: 'sistema' } as const;

describe('generarBrief: the brief is stored', () => {
  it('stores the brief, its slots and fact links, moves the piece, and writes history, audit and one ledger row', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      await createPiezaHecho(db, { piezaId: pieza.id, hechoId: w.facts.precio, clienteId: w.clienteId });
      w.provider.enqueue(briefJson(w, { primeraEscena: `Hoy: ${factToken(w.facts.precio)}`, media: [w.photos[0]!.id, w.photos[1]!.id, null, w.photos[2]!.id, w.photos[3]!.id] }));

      const result = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);

      expect(result.guion).toMatchObject({ cliente_id: w.clienteId, pieza_id: pieza.id, version: 1, es_actual: true, formato: 'carrusel', perfil_marca_id: w.perfilId, creado_por: null });
      expect(result.guion.tomas.map((t) => [t.orden, t.fuente, t.media_id])).toEqual([
        [1, 'media_real', w.photos[0]!.id],
        [2, 'media_real', w.photos[1]!.id],
        [3, 'faltante', null],
        [4, 'media_real', w.photos[2]!.id],
        [5, 'media_real', w.photos[3]!.id],
      ]);
      expect(result.guion.tomas[2]!.motivo_faltante).toBe('No hay media adecuada');
      expect(result.guion.hecho_ids).toEqual([w.facts.precio]);

      // The piece moved plan_aprobado -> guion_listo through the state machine.
      expect(result.pieza).toMatchObject({ estado: 'guion_listo', version_estado: 2 });
      const history = await getHistorial(db, w.clienteId, pieza.id);
      expect(history.at(-1)).toMatchObject({ desde: 'plan_aprobado', hacia: 'guion_listo', actor_tipo: 'sistema', motivo: 'Guion generado (versión 1)' });

      // One ledger row for the model call, and the returned cost matches it.
      const rows = await ledger(db, w.clienteId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ resultado: 'ok', proposito: BRIEF_PURPOSE });
      expect(result.generacion.intentos).toBe(1);
      expect(microToUsd(result.generacion.costo)).toBe(rows[0].costo);
      expect(w.provider.calls).toHaveLength(1);
      expect(w.provider.calls[0]!.maxOutputTokens).toBe(maxOutputTokensFor('carrusel'));
      expect(maxOutputTokensFor('carrusel')).toBe(4200);
      expect(w.alerts.alerts).toEqual([]);

      // Audit: one row for the brief (counts and ids, never the copy) and one for the state change.
      const audit = await auditRowsFor(db, 'guiones', result.guion.id);
      expect(audit.map((a) => a.accion)).toEqual(['crear']);
      expect(audit[0]!.datos_despues).toMatchObject({ pieza_id: pieza.id, version: 1, escenas: 5, con_media: 4, faltantes: 1, hecho_ids: [w.facts.precio] });
      for (const text of SECRET_TEXTS) expect(JSON.stringify(audit)).not.toContain(text);
      expect((await auditRowsFor(db, 'piezas', pieza.id)).filter((a) => a.accion === 'cambiar_estado')).toHaveLength(1);
    });
  });

  it('renders the tokens with the stored values: no token survives, the model content keeps them', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      await createPiezaHecho(db, { piezaId: pieza.id, hechoId: w.facts.precio, clienteId: w.clienteId });
      w.provider.enqueue(briefJson(w, { primeraEscena: `Hoy: ${factToken(w.facts.precio)} y ${factToken(w.facts.horario)}` }));
      const { guion } = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);

      expect(guion.contenido.escenas[0]!.texto_en_pantalla).toBe(`Hoy: ${w.enunciados[w.facts.precio]} y ${w.enunciados[w.facts.horario]}`);
      expect(JSON.stringify(guion.contenido)).not.toContain('{{hecho:');
      expect(guion.contenido_modelo).toBeUndefined(); // not exposed by default

      const withModel = (await getBriefActual(db, w.clienteId, pieza.id, { includeModel: true }))!;
      expect(withModel.contenido_modelo!.escenas[0]!.texto_en_pantalla).toContain(factToken(w.facts.precio));
      // Both facts used in tokens are linked, nothing else.
      expect([...guion.hecho_ids].sort()).toEqual([w.facts.precio, w.facts.horario].sort());
    });
  });

  it('marks every slot as missing media when the library has nothing usable', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, new FakeLLMProvider(), { photos: 0 });
      const pieza = await piece(w);
      w.provider.enqueue(briefJson(w, { media: [null, null, null, null, null] }));
      const { guion } = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);
      expect(guion.tomas.map((t) => t.fuente)).toEqual(Array(5).fill('faltante'));
    });
  });

  it('the first brief of a plan approved through aprobarPlanInterno', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const draft = await createPlanSemanal(db, { clienteId: w.clienteId, perfilMarcaId: w.perfilId, semanaInicio: '2026-11-16' });
      const pieza = await createPieza(db, { clienteId: w.clienteId, planId: draft.id, formato: 'carrusel' });
      // Still a draft: no brief, no call.
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA)).rejects.toBeInstanceOf(PlanNoAprobadoError);
      await aprobarPlanInterno(db, w.clienteId, draft.id, SISTEMA);
      w.provider.enqueue(briefJson(w));
      const { pieza: after } = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);
      expect(after.estado).toBe('guion_listo');
      expect(w.provider.calls).toHaveLength(1);
    });
  });
});

describe('generarBrief: refused before paying', () => {
  it('a piece in the wrong state, a paused piece, a plan that is not approved or is discarded: typed error and 0 calls', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.provider.enqueue(briefJson(w));
      const planeada = await createPieza(db, { clienteId: w.clienteId, planId: w.planId });
      const enProduccion = await piece(w, { estado: 'en_produccion' });
      const pausada = await piece(w);
      await pausarPieza(db, w.clienteId, pausada.id, SISTEMA);

      for (const id of [planeada.id, enProduccion.id, pausada.id]) {
        await expect(generarBrief(w.deps, w.clienteId, id, SISTEMA)).rejects.toBeInstanceOf(PiezaEstadoInvalidoError);
      }

      const borrador = await createPlanSemanal(db, { clienteId: w.clienteId, perfilMarcaId: w.perfilId, semanaInicio: '2026-11-16' });
      const enBorrador = await createPieza(db, { clienteId: w.clienteId, planId: borrador.id });
      await expect(generarBrief(w.deps, w.clienteId, enBorrador.id, SISTEMA)).rejects.toBeInstanceOf(PlanNoAprobadoError);

      const buena = await piece(w);
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [w.planId]);
      await expect(generarBrief(w.deps, w.clienteId, buena.id, SISTEMA)).rejects.toBeInstanceOf(PlanDescartadoError);

      await expect(generarBrief(w.deps, w.clienteId, '00000000-0000-4000-8000-000000000000', SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(w.provider.calls).toHaveLength(0);
      expect(await ledger(db, w.clienteId)).toEqual([]);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(0);
    });
  });

  it('a refused budget means 0 provider calls and no brief', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      w.provider.enqueue(briefJson(w));
      await db.query('UPDATE configuracion_gasto_cliente SET techo_mensual_defecto = 0 WHERE cliente_id = $1', [w.clienteId]);
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA)).rejects.toMatchObject({ reason: 'techo_superado' });
      await db.query('UPDATE configuracion_gasto_cliente SET techo_mensual_defecto = 1, gasto_habilitado = false WHERE cliente_id = $1', [w.clienteId]);
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA)).rejects.toBeInstanceOf(BudgetRefusedError);
      expect(w.provider.calls).toHaveLength(0);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(0);
      expect((await getPieza(db, w.clienteId, pieza.id))!.estado).toBe('plan_aprobado');
    });
  });
});

describe('generarBrief: versions', () => {
  it('refuses a second brief without regenerar; regenerating makes version 2 and keeps version 1', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      w.provider.enqueue(briefJson(w));
      const first = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);

      w.provider.enqueue(briefJson(w, { primeraEscena: 'Otra escena inicial del origen' }));
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA)).rejects.toMatchObject({ name: BriefExistenteError.name, version: 1 });
      expect(w.provider.calls).toHaveLength(1); // the refusal cost nothing

      const second = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA, { regenerar: true });
      expect(second.guion.version).toBe(2);
      expect(second.guion.contenido.escenas[0]!.texto_en_pantalla).toBe('Otra escena inicial del origen');
      // The piece stays in guion_listo: no new transition.
      expect(second.pieza).toMatchObject({ estado: 'guion_listo', version_estado: first.pieza.version_estado });

      const versions = await listBriefVersions(db, w.clienteId, pieza.id);
      expect(versions.map((v) => [v.version, v.es_actual])).toEqual([[1, false], [2, true]]);
      expect(versions[0]!.contenido.escenas[0]!.texto_en_pantalla).toBe('Escena inicial del origen');
      expect(versions[0]!.tomas).toHaveLength(5);
      expect((await getBriefActual(db, w.clienteId, pieza.id))!.version).toBe(2);
      expect((await auditRowsFor(db, 'guiones', first.guion.id)).map((a) => a.accion)).toEqual(['crear', 'retirar']);
      expect(await ledger(db, w.clienteId)).toHaveLength(2);
    });
  });

  it('regenerating is refused once the piece left guion_listo', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      w.provider.enqueue(briefJson(w));
      await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);
      await moverPieza(db, pieza.id, 'en_produccion');
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA, { regenerar: true })).rejects.toMatchObject({ name: PiezaEstadoInvalidoError.name, estado: 'en_produccion' });
      expect(w.provider.calls).toHaveLength(1);
    });
  });
});

describe('generarBrief: invalid model output', () => {
  it('invalid output then valid output: two ledger rows and one brief', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      w.provider.enqueue('this is not json', briefJson(w));
      const result = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);
      expect(result.generacion.intentos).toBe(2);
      expect(await ledger(db, w.clienteId)).toHaveLength(2);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(1);
      expect(w.alerts.alerts).toEqual([]);
    });
  });

  it('a semantic error (a price typed as text) uses the retry, too', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      w.provider.enqueue(briefJson(w, { primeraEscena: 'El café cuesta $6.000 COP' }), briefJson(w));
      const result = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);
      expect(result.generacion.intentos).toBe(2);
      expect(JSON.stringify(result.guion.contenido)).not.toContain('6.000');
    });
  });

  it('invalid output twice: an alert, no brief, and the piece is unchanged', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      w.provider.enqueue('nope', briefJson(w, { primeraEscena: 'Solo 10 días' }));
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA)).rejects.toBeInstanceOf(SchemaValidationError);
      expect(w.alerts.alerts).toHaveLength(1);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(0);
      expect(await ledger(db, w.clienteId)).toHaveLength(2);
      const after = (await getPieza(db, w.clienteId, pieza.id))!;
      expect(after).toMatchObject({ estado: 'plan_aprobado', version_estado: pieza.version_estado });
    });
  });
});

describe('generarBrief: rule 2 and real media, re-checked when storing', () => {
  it('a fact that expires between the model call and the write gives no brief', async () => {
    await withTestTransaction(async (db) => {
      let expire: () => Promise<void> = async () => undefined;
      const w = await world(db, new ProviderWithSideEffect(() => expire()));
      const pieza = await piece(w);
      expire = async () => {
        await db.query(`UPDATE hechos_verificados SET vigente_desde = now() - interval '2 days', vigente_hasta = now() WHERE id = $1`, [w.facts.horario]);
      };
      w.provider.enqueue(briefJson(w, { primeraEscena: `Mira ${factToken(w.facts.horario)}` }));
      const error = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BriefHechoVencidoError);
      expect((error as BriefHechoVencidoError).hechoIds).toEqual([w.facts.horario]);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(0);
      expect(await countRows(db, 'tomas', w.clienteId)).toBe(0);
      expect(await countRows(db, 'guiones_hechos', w.clienteId)).toBe(0);
      expect((await getPieza(db, w.clienteId, pieza.id))!.estado).toBe('plan_aprobado');
      expect(await ledger(db, w.clienteId)).toHaveLength(1); // the model call was made and paid
    });
  });

  it('a fact shortened to end before the piece goes out is refused too (valid now, not then)', async () => {
    await withTestTransaction(async (db) => {
      let edit: () => Promise<void> = async () => undefined;
      const w = await world(db, new ProviderWithSideEffect(() => edit()));
      const pieza = await piece(w); // scheduled 3 days ahead
      edit = async () => {
        await db.query(`UPDATE hechos_verificados SET vigente_hasta = now() + interval '1 day' WHERE id = $1`, [w.facts.precio]);
      };
      w.provider.enqueue(briefJson(w, { primeraEscena: `Mira ${factToken(w.facts.precio)}` }));
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA)).rejects.toBeInstanceOf(BriefHechoVencidoError);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(0);
    });
  });

  it('a media item whose rights expire between the call and the write gives no brief', async () => {
    await withTestTransaction(async (db) => {
      let expire: () => Promise<void> = async () => undefined;
      const w = await world(db, new ProviderWithSideEffect(() => expire()));
      const pieza = await piece(w);
      expire = async () => {
        await db.query(`UPDATE media SET derechos_hasta = now() WHERE id = $1`, [w.photos[0]!.id]);
      };
      w.provider.enqueue(briefJson(w));
      const error = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BriefMediaNoUsableError);
      expect((error as BriefMediaNoUsableError).mediaIds).toEqual([w.photos[0]!.id]);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(0);
      expect((await getPieza(db, w.clienteId, pieza.id))!.estado).toBe('plan_aprobado');
    });
  });

  it('a media item whose person authorization is revoked between the call and the write gives no brief', async () => {
    await withTestTransaction(async (db) => {
      let revoke: () => Promise<void> = async () => undefined;
      const w = await world(db, new ProviderWithSideEffect(() => revoke()));
      const conGente = await createMedia(db, { clienteId: w.clienteId, tipo: 'foto', aparecenPersonas: true, etiquetas: ['cafe'] });
      const link = await createMediaAutorizacion(db, { mediaId: conGente.id, clienteId: w.clienteId });
      const pieza = await piece(w);
      revoke = async () => {
        await db.query('UPDATE autorizaciones_imagen SET revocada_en = now() WHERE id = $1', [link.autorizacion_id]);
      };
      w.provider.enqueue(briefJson(w, { media: [conGente.id, ...w.photos.slice(0, 4).map((m) => m.id)] }));
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA)).rejects.toMatchObject({ name: BriefMediaNoUsableError.name, mediaIds: [conGente.id] });
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(0);
    });
  });

  it('media of the model that is not a candidate (another client\'s) is rejected by the schema, with the retry', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const other = await createCliente(db);
      const foreign = await createMedia(db, { clienteId: other.id, tipo: 'foto' });
      const pieza = await piece(w);
      w.provider.enqueue(briefJson(w, { media: [foreign.id, ...w.photos.slice(0, 4).map((m) => m.id)] }), briefJson(w));
      const result = await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);
      expect(result.generacion.intentos).toBe(2);
      expect(result.guion.tomas.every((t) => t.media_id !== foreign.id)).toBe(true);
    });
  });
});

describe('generarBrief: concurrency', () => {
  it('a piece that moved while the model was running gives no brief', async () => {
    await withTestTransaction(async (db) => {
      let move: () => Promise<void> = async () => undefined;
      const w = await world(db, new ProviderWithSideEffect(() => move()));
      const pieza = await piece(w);
      move = async () => {
        await pausarPieza(db, w.clienteId, pieza.id, SISTEMA);
      };
      w.provider.enqueue(briefJson(w));
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA)).rejects.toBeInstanceOf(BriefObsoletoError);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(0);
    });
  });

  it('a brief created by someone else while the model was running gives no second brief', async () => {
    await withTestTransaction(async (db) => {
      let other: () => Promise<void> = async () => undefined;
      const w = await world(db, new ProviderWithSideEffect(() => other()));
      const pieza = await piece(w);
      other = async () => {
        await createGuion(db, { piezaId: pieza.id });
      };
      w.provider.enqueue(briefJson(w));
      await expect(generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA)).rejects.toBeInstanceOf(BriefObsoletoError);
      expect(await countRows(db, 'guiones', w.clienteId)).toBe(1);
    });
  });
});

describe('generarBrief: clients and logs', () => {
  it('client A cannot generate or read client B\'s briefs', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w);
      w.provider.enqueue(briefJson(w));
      const stranger = asClienteId((await createCliente(db)).id);
      await expect(generarBrief(w.deps, stranger, pieza.id, SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(w.provider.calls).toHaveLength(0);

      await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);
      expect(await getBriefActual(db, stranger, pieza.id)).toBeNull();
      expect(await listBriefVersions(db, stranger, pieza.id)).toEqual([]);
      expect(await getBriefActual(db, w.clienteId, pieza.id)).not.toBeNull();
    });
  });

  it('logs contain ids and counts, never the prompt, the copy or the idea', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const pieza = await piece(w, { idea: 'Una idea única del planificador' });
      w.provider.enqueue('basura', briefJson(w));
      await generarBrief(w.deps, w.clienteId, pieza.id, SISTEMA);
      const logs = w.logs.join('\n');
      expect(logs).toContain('brief stored');
      for (const text of [...SECRET_TEXTS, 'Una idea única', 'Cafetería Aurora', 'creative director', 'EXTERNAL_DATA', 'Nuestro barrio', 'basura']) {
        expect(logs, text).not.toContain(text);
      }
    });
  });
});

describe('generarBriefsDelPlan', () => {
  it('runs the eligible pieces one at a time and reports each; one failing piece does not undo the others', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const t0 = Date.now() + 3 * 24 * 3600_000;
      const a = await piece(w, { fechaHora: new Date(t0) });
      const b = await piece(w, { fechaHora: new Date(t0 + 3600_000) }); // will fail: invalid output twice
      const c = await piece(w, { fechaHora: new Date(t0 + 2 * 3600_000) });
      const yaTiene = await piece(w, { fechaHora: new Date(t0 + 3 * 3600_000) });
      await createGuion(db, { piezaId: yaTiene.id });
      await moverPieza(db, yaTiene.id, 'guion_listo');
      const pausada = await piece(w, { fechaHora: new Date(t0 + 4 * 3600_000) });
      await pausarPieza(db, w.clienteId, pausada.id, SISTEMA);

      w.provider.enqueue(briefJson(w), 'x', 'y', briefJson(w, { media: w.photos.slice(1, 6).map((m) => m.id) }));
      const result = await generarBriefsDelPlan(w.deps, w.clienteId, w.planId, SISTEMA);

      expect(result.detenidoPorPresupuesto).toBe(false);
      expect(result.resultados).toEqual([
        { piezaId: a.id, resultado: 'ok', version: 1 },
        { piezaId: b.id, resultado: 'fallida', codigo: 'SchemaValidationError' },
        { piezaId: c.id, resultado: 'ok', version: 1 },
        { piezaId: yaTiene.id, resultado: 'omitida', motivo: 'ya_tiene_guion' },
        { piezaId: pausada.id, resultado: 'omitida', motivo: 'estado_pausada' },
      ]);
      expect((await getPieza(db, w.clienteId, a.id))!.estado).toBe('guion_listo');
      expect((await getPieza(db, w.clienteId, b.id))!.estado).toBe('plan_aprobado');
      expect((await getPieza(db, w.clienteId, c.id))!.estado).toBe('guion_listo');
    });
  });

  it('stops when the budget refuses, without calling for the remaining pieces', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const t0 = Date.now() + 3 * 24 * 3600_000;
      const piezas = [];
      for (let i = 0; i < 3; i++) piezas.push(await piece(w, { fechaHora: new Date(t0 + i * 3600_000) }));
      // The first brief spends (and creates the month's ceiling); then the ceiling drops to zero.
      w.provider.enqueue(briefJson(w), briefJson(w), briefJson(w));
      await generarBrief(w.deps, w.clienteId, piezas[0]!.id, SISTEMA);
      await db.query('UPDATE topes SET monto_techo = 0 WHERE cliente_id = $1', [w.clienteId]);
      const callsBefore = w.provider.calls.length;

      const result = await generarBriefsDelPlan(w.deps, w.clienteId, w.planId, SISTEMA);
      expect(result.detenidoPorPresupuesto).toBe(true);
      expect(result.resultados.map((r) => [r.piezaId, r.resultado, r.codigo ?? r.motivo])).toEqual([
        [piezas[0]!.id, 'omitida', 'ya_tiene_guion'],
        [piezas[1]!.id, 'fallida', 'BudgetRefusedError'],
        [piezas[2]!.id, 'omitida', 'presupuesto'],
      ]);
      expect(w.provider.calls).toHaveLength(callsBefore); // the refused authorization never reached the provider
    });
  });

  it('refuses a plan that is not approved, discarded, or of another client, before anything is paid', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const borrador = await createPlanSemanal(db, { clienteId: w.clienteId, perfilMarcaId: w.perfilId, semanaInicio: '2026-11-16' });
      await expect(generarBriefsDelPlan(w.deps, w.clienteId, borrador.id, SISTEMA)).rejects.toBeInstanceOf(PlanNoAprobadoError);
      const stranger = asClienteId((await createCliente(db)).id);
      await expect(generarBriefsDelPlan(w.deps, stranger, w.planId, SISTEMA)).rejects.toMatchObject({ name: 'PlanNotFoundError' });
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [w.planId]);
      await expect(generarBriefsDelPlan(w.deps, w.clienteId, w.planId, SISTEMA)).rejects.toBeInstanceOf(PlanDescartadoError);
      expect(w.provider.calls).toHaveLength(0);
    });
  });
});
