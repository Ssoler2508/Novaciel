import type { Logger } from 'pino';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import type { AlertSink } from '../../lib/ai/alerts.js';
import type { LLMProvider } from '../../lib/ai/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { generateStructured } from '../ai/generateStructured.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { getValidHechos } from '../hechos/hechosRepository.js';
import { usableCondition } from '../media/usable.js';
import { getUsableMedia } from '../media/mediaRepository.js';
import { getCurrentPerfilMarca } from '../perfilMarca/perfilMarcaRepository.js';
import { PiezaNotFoundError, PlanDescartadoError } from '../piezas/errors.js';
import { getPieza, listPiezas, type PiezaRow } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { PlanNoAprobadoError, PlanNotFoundError } from '../planificador/errors.js';
import { getPlan } from '../planificador/planesRepository.js';
import { PriceNotFoundError } from '../precios/preciosRepository.js';
import type { MicroUsd } from '../presupuesto/money.js';
import { BudgetRefusedError } from '../presupuesto/presupuestoService.js';
import { listReglas } from '../reglasProhibidas/reglasRepository.js';
import type { ClienteId } from '../shared/clienteId.js';
import { selectCandidateMedia } from './candidates.js';
import { buildBriefContext } from './context.js';
import {
  BriefContextError,
  BriefExistenteError,
  BriefHechoVencidoError,
  BriefMediaNoUsableError,
  BriefObsoletoError,
  FactTokenError,
  PiezaEstadoInvalidoError,
} from './errors.js';
import { getBriefActual, type GuionView } from './guionesRepository.js';
import { LIMITES_FORMATO } from './limits.js';
import { buildBriefPrompt } from './prompt.js';
import { buildBriefSchema, type BriefContent } from './schema.js';
import { extractFactTokenIds, isValidAt, renderFactTokens } from './tokens.js';
import type { BriefContext, HechoBrief } from './types.js';

// The creative director's service. Reads through the repositories (always filtered by cliente_id),
// builds the context and prompt (pure, rule 9), calls generateStructured (budget, one retry, alert)
// OUTSIDE any write transaction, and stores the brief, its slots, its fact links and the piece's
// state change in ONE transaction. Rule 2: the fact tokens are rendered inside that transaction,
// with the facts valid NOW. Logs carry ids, versions and counts only: never the prompt, the copy or
// the idea.

export const BRIEF_PURPOSE = 'brief_creativo';

/**
 * Output budget, a constant formula derived from the format's limits: 1200 tokens for the caption
 * and the fixed fields plus 300 per scene or slide at the format's maximum.
 */
export function maxOutputTokensFor(formato: keyof typeof LIMITES_FORMATO): number {
  return 1200 + 300 * LIMITES_FORMATO[formato].escenasMax;
}

export interface DirectorDeps {
  db: Db;
  provider: LLMProvider;
  alerts: AlertSink;
  logger?: Logger;
  /**
   * Development side channel, used ONLY by the deterministic development provider: it runs the model
   * call with the structured context available to the provider, so the fake never has to read the
   * prompt. Real providers do not set it.
   */
  withContext?: <T>(context: BriefContext, run: () => Promise<T>) => Promise<T>;
}

export interface GenerarBriefOptions {
  /** Make a new version of an existing brief. Allowed only while the piece is still in guion_listo. */
  regenerar?: boolean;
}

export interface BriefGenerado {
  guion: GuionView;
  pieza: PiezaRow;
  generacion: { intentos: number; costo: MicroUsd };
}

const ESTADOS_CON_BRIEF = ['plan_aprobado', 'guion_listo'] as const;

/**
 * The free, read-only checks before a brief is paid for: the piece exists for this client, its plan
 * is approved and not discarded, the piece is in a state a brief can be made from, and a current
 * brief is not in the way. The routes use the same function, so they cannot disagree with the
 * service. Returns the piece and the version of its current brief (null when it has none).
 */
export async function assertPiezaElegible(
  db: Db,
  clienteId: ClienteId,
  piezaId: string,
  regenerar: boolean,
): Promise<{ pieza: PiezaRow; versionActual: number | null }> {
  const pieza = await getPieza(db, clienteId, piezaId, { includeDescartados: true });
  if (!pieza) throw new PiezaNotFoundError();
  if (pieza.plan_estado === 'descartado') throw new PlanDescartadoError();
  if (pieza.plan_estado !== 'aprobado') throw new PlanNoAprobadoError(pieza.plan_estado);
  if (!(ESTADOS_CON_BRIEF as readonly string[]).includes(pieza.estado)) throw new PiezaEstadoInvalidoError(pieza.estado);
  const actual = await getBriefActual(db, clienteId, piezaId, { includeDescartados: true });
  const versionActual = actual?.version ?? null;
  if (versionActual !== null && !regenerar) throw new BriefExistenteError(versionActual);
  return { pieza, versionActual };
}

export async function generarBrief(
  deps: DirectorDeps,
  clienteId: ClienteId,
  piezaId: string,
  actor: AuditActor,
  options: GenerarBriefOptions = {},
): Promise<BriefGenerado> {
  const { db } = deps;
  const log = deps.logger ?? defaultLogger;
  const regenerar = options.regenerar ?? false;

  // 1. Eligibility, read-only: nothing is paid for before this passes. The lock is taken at write
  //    time (step 6): holding a row lock across a paid model call would block the whole piece.
  const { pieza: piezaVista, versionActual: versionVista } = await assertPiezaElegible(db, clienteId, piezaId, regenerar);

  // 2. Context and prompt (pure).
  const [plan, perfil] = await Promise.all([getPlan(db, clienteId, piezaVista.plan_id), getCurrentPerfilMarca(db, clienteId)]);
  if (!plan) throw new PlanNotFoundError();
  if (!perfil) throw new BriefContextError('perfil');
  const hechos: HechoBrief[] = (await getValidHechos(db, clienteId)).map((h) => ({
    id: h.id,
    tipo: h.tipo,
    enunciado: h.enunciado,
    vigente_desde: h.vigente_desde,
    vigente_hasta: h.vigente_hasta,
  }));
  const reglas = (await listReglas(db, clienteId)).map((r) => ({ tipo: r.tipo, texto: r.texto }));
  const candidatos = selectCandidateMedia({
    media: await getUsableMedia(db, clienteId),
    pieza: { red: piezaVista.red, formato: piezaVista.formato, pilar: piezaVista.pilar, idea: piezaVista.idea },
    reglas,
  });
  const context = buildBriefContext({
    pieza: {
      id: piezaVista.id,
      red: piezaVista.red,
      formato: piezaVista.formato,
      pilar: piezaVista.pilar,
      trabajo: piezaVista.trabajo,
      idea: piezaVista.idea,
      fechaHora: piezaVista.fecha_hora,
      hechoIds: piezaVista.hecho_ids,
    },
    zonaHoraria: plan.zona_horaria,
    perfil: {
      identidad: perfil.identidad,
      voz: perfil.voz,
      kit_visual: perfil.kit_visual,
      idioma_contenido: perfil.idioma_contenido,
    },
    hechos,
    reglas,
    media: candidatos,
  });

  // 3. The model call: budget, estimate, authorization, single retry and alert live here.
  const callModel = () =>
    generateStructured<BriefContent>(
      { db, provider: deps.provider, alerts: deps.alerts, logger: log },
      {
        clienteId,
        purpose: BRIEF_PURPOSE,
        schema: buildBriefSchema(context),
        prompt: buildBriefPrompt(context),
        maxOutputTokens: maxOutputTokensFor(piezaVista.formato),
        actor,
      },
    );
  const generated = await (deps.withContext ? deps.withContext(context, callModel) : callModel());
  const contenidoModelo = generated.data;

  // 4. One transaction stores everything.
  const stored = await runInTransaction(db, async (tx) => {
    // LOCK ORDER (the same everywhere, also in aprobarPlanInterno): the plan first, then the piece.
    const { rows: planRows } = await tx.query<{ estado: string }>(
      'SELECT estado FROM planes_semanales WHERE id = $1 AND cliente_id = $2 FOR SHARE',
      [piezaVista.plan_id, clienteId],
    );
    if (!planRows[0]) throw new PlanNotFoundError();
    if (planRows[0].estado === 'descartado') throw new PlanDescartadoError();
    if (planRows[0].estado !== 'aprobado') throw new PlanNoAprobadoError(planRows[0].estado);

    const { rows: piezaRows } = await tx.query<{ estado: string }>(
      'SELECT estado FROM piezas WHERE id = $1 AND cliente_id = $2 FOR UPDATE',
      [piezaId, clienteId],
    );
    // The piece moved (paused, produced...) while the model was running.
    if (!piezaRows[0] || piezaRows[0].estado !== piezaVista.estado) throw new BriefObsoletoError();

    const { rows: currentRows } = await tx.query<{ id: string; version: number }>(
      'SELECT id, version FROM guiones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual FOR UPDATE',
      [piezaId, clienteId],
    );
    const current = currentRows[0] ?? null;
    // Someone generated (or regenerated) a brief while the model was running.
    if ((current?.version ?? null) !== versionVista) throw new BriefObsoletoError();

    // Rule 2, again: every fact named by a token must be valid NOW (database clock) and when the
    // piece goes out. The tokens are rendered with exactly the facts valid now.
    const { rows: ahoraRows } = await tx.query<{ ahora: Date }>('SELECT now() AS ahora');
    const ahora = ahoraRows[0]!.ahora;
    const tokenIds = extractFactTokenIds(contenidoModelo);
    const { rows: hechosAhora } = tokenIds.length
      ? await tx.query<HechoBrief>(
          `SELECT id, tipo, enunciado, vigente_desde, vigente_hasta FROM hechos_verificados
           WHERE cliente_id = $1 AND id = ANY($2::uuid[]) AND vigente_desde <= now() AND (vigente_hasta IS NULL OR vigente_hasta > now())
           FOR SHARE`,
          [clienteId, tokenIds],
        )
      : { rows: [] as HechoBrief[] };
    const porId = new Map(hechosAhora.map((h) => [h.id, h]));
    const vencidos = tokenIds.filter((id) => {
      const hecho = porId.get(id);
      return !hecho || !isValidAt(hecho, piezaVista.fecha_hora);
    });
    if (vencidos.length > 0) throw new BriefHechoVencidoError(vencidos);
    let contenido: BriefContent;
    try {
      contenido = renderFactTokens(contenidoModelo, hechosAhora, ahora);
    } catch (error) {
      if (error instanceof FactTokenError && error.hechoId) throw new BriefHechoVencidoError([error.hechoId]);
      throw error;
    }

    // Real media only, and still usable now (rights, authorizations, not deleted).
    const mediaIds = [...new Set(contenidoModelo.escenas.flatMap((e) => (e.toma.media_id ? [e.toma.media_id] : [])))];
    if (mediaIds.length > 0) {
      const { rows: usables } = await tx.query<{ id: string }>(
        `SELECT m.id FROM media m WHERE m.cliente_id = $1 AND m.id = ANY($2::uuid[]) AND ${usableCondition('now()')} FOR SHARE OF m`,
        [clienteId, mediaIds],
      );
      const okIds = new Set(usables.map((u) => u.id));
      const perdidos = mediaIds.filter((id) => !okIds.has(id));
      if (perdidos.length > 0) throw new BriefMediaNoUsableError(perdidos);
    }

    // The previous current brief is retired, the new version is born current.
    const { rows: maxRows } = await tx.query<{ n: number }>('SELECT COALESCE(max(version), 0)::int AS n FROM guiones WHERE pieza_id = $1', [piezaId]);
    const version = maxRows[0]!.n + 1;
    if (current) {
      await tx.query('UPDATE guiones SET es_actual = false WHERE id = $1 AND cliente_id = $2', [current.id, clienteId]);
      await recordAudit(tx, {
        actor,
        accion: 'retirar',
        tabla: 'guiones',
        filaId: current.id,
        clienteId,
        antes: { es_actual: true },
        despues: { es_actual: false, motivo: 'nueva versión', version_nueva: version },
      });
    }
    const { rows: guionRows } = await tx.query<{ id: string }>(
      `INSERT INTO guiones (cliente_id, pieza_id, version, es_actual, perfil_marca_id, formato, contenido_modelo, contenido, creado_por)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8) RETURNING id`,
      [
        clienteId,
        piezaId,
        version,
        perfil.id,
        piezaVista.formato,
        JSON.stringify(contenidoModelo),
        JSON.stringify(contenido),
        actor.tipo === 'usuario' ? actor.usuarioId : null,
      ],
    );
    const guionId = guionRows[0]!.id;
    for (const escena of contenidoModelo.escenas) {
      const { toma } = escena;
      await tx.query(
        `INSERT INTO tomas (guion_id, cliente_id, orden, fuente, media_id, motivo_faltante, entrada_ms, salida_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          guionId,
          clienteId,
          escena.orden,
          toma.media_id ? 'media_real' : 'faltante',
          toma.media_id,
          toma.media_id ? null : (toma.motivo_faltante ?? null),
          toma.entrada_ms ?? null,
          toma.salida_ms ?? null,
        ],
      );
    }
    for (const hechoId of tokenIds) {
      await tx.query('INSERT INTO guiones_hechos (guion_id, hecho_id, cliente_id) VALUES ($1, $2, $3)', [guionId, hechoId, clienteId]);
    }
    const conMedia = mediaIds.length;
    await recordAudit(tx, {
      actor,
      accion: 'crear',
      tabla: 'guiones',
      filaId: guionId,
      clienteId,
      // Ids and counts only: the copy is deliberately not copied here.
      despues: {
        pieza_id: piezaId,
        version,
        formato: piezaVista.formato,
        perfil_marca_id: perfil.id,
        escenas: contenidoModelo.escenas.length,
        con_media: conMedia,
        faltantes: contenidoModelo.escenas.length - conMedia,
        hecho_ids: tokenIds,
      },
    });

    // The first brief moves the piece to guion_listo (history and audit written by the state
    // machine); a regeneration leaves it where it is.
    const piezaFinal =
      piezaVista.estado === 'plan_aprobado'
        ? await transitionPieza(tx, clienteId, piezaId, 'guion_listo', actor, { motivo: `Guion generado (versión ${version})` })
        : (await getPieza(tx, clienteId, piezaId, { includeDescartados: true }))!;
    return { pieza: piezaFinal, guion: (await getBriefActual(tx, clienteId, piezaId, { includeDescartados: true }))!, version };
  });

  log.info(
    { clienteId, piezaId, guionId: stored.guion.id, version: stored.version, escenas: stored.guion.tomas.length, intentos: generated.attempts, costo: generated.cost.toString() },
    'brief stored',
  );
  return { guion: stored.guion, pieza: stored.pieza, generacion: { intentos: generated.attempts, costo: generated.cost } };
}

// ---------------------------------------------------------------------------------------------

export interface ResultadoPieza {
  piezaId: string;
  resultado: 'ok' | 'omitida' | 'fallida';
  /** For 'ok': the stored version. */
  version?: number;
  /** For 'ok': what the model call cost (micro-USD). */
  costo?: MicroUsd;
  /** For 'omitida': why. For 'fallida': the error name. Never content. */
  motivo?: string;
  codigo?: string;
}

export interface BriefsDelPlan {
  planId: string;
  resultados: ResultadoPieza[];
  /** True when the budget (or a missing price) stopped the run before the last piece. */
  detenidoPorPresupuesto: boolean;
}

/**
 * Generates the brief of every eligible piece of an approved plan, one at a time, in scheduled
 * order. One piece failing does not undo the others. A budget refusal (or a missing price, which
 * would refuse every piece the same way) stops the run: the remaining pieces are not even tried.
 */
export async function generarBriefsDelPlan(deps: DirectorDeps, clienteId: ClienteId, planId: string, actor: AuditActor): Promise<BriefsDelPlan> {
  const log = deps.logger ?? defaultLogger;
  const plan = await getPlan(deps.db, clienteId, planId);
  if (!plan) throw new PlanNotFoundError();
  if (plan.estado === 'descartado') throw new PlanDescartadoError();
  if (plan.estado !== 'aprobado') throw new PlanNoAprobadoError(plan.estado);

  const piezas = await listPiezas(deps.db, clienteId, { planId });
  const resultados: ResultadoPieza[] = [];
  let detenido = false;
  for (const pieza of piezas) {
    if (detenido) {
      resultados.push({ piezaId: pieza.id, resultado: 'omitida', motivo: 'presupuesto' });
      continue;
    }
    if (pieza.estado === 'guion_listo') {
      resultados.push({ piezaId: pieza.id, resultado: 'omitida', motivo: 'ya_tiene_guion' });
      continue;
    }
    if (pieza.estado !== 'plan_aprobado') {
      resultados.push({ piezaId: pieza.id, resultado: 'omitida', motivo: `estado_${pieza.estado}` });
      continue;
    }
    try {
      const result = await generarBrief(deps, clienteId, pieza.id, actor);
      resultados.push({ piezaId: pieza.id, resultado: 'ok', version: result.guion.version, costo: result.generacion.costo });
    } catch (error) {
      const codigo = error instanceof Error ? error.name : 'Error';
      resultados.push({ piezaId: pieza.id, resultado: 'fallida', codigo });
      if (error instanceof BudgetRefusedError || error instanceof PriceNotFoundError) detenido = true;
      else log.warn({ clienteId, planId, piezaId: pieza.id, codigo }, 'brief failed; continuing with the next piece');
    }
  }
  log.info(
    { clienteId, planId, ok: resultados.filter((r) => r.resultado === 'ok').length, fallidas: resultados.filter((r) => r.resultado === 'fallida').length, detenido },
    'plan briefs finished',
  );
  return { planId, resultados, detenidoPorPresupuesto: detenido };
}
