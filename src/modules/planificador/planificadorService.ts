import type { Logger } from 'pino';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import type { AlertSink } from '../../lib/ai/alerts.js';
import type { LLMProvider } from '../../lib/ai/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { generateStructured } from '../ai/generateStructured.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { getValidHechos } from '../hechos/hechosRepository.js';
import { listPiezas, type PiezaRow } from '../piezas/piezasRepository.js';
import { getCompleteness } from '../perfilMarca/puedePlanificar.js';
import { getCurrentPerfilMarca } from '../perfilMarca/perfilMarcaRepository.js';
import type { MicroUsd } from '../presupuesto/money.js';
import { listReglas } from '../reglasProhibidas/reglasRepository.js';
import type { ClienteId } from '../shared/clienteId.js';
import { buildPlannerContext } from './context.js';
import { HechoVencidoError, NoPuedePlanificarError, PlanExistenteError, PlannerContextError } from './errors.js';
import { isValidLocalDate, isValidZone, localDateOf, mondayOf } from './fechas.js';
import { getPlan, getPlanActivoDeSemana, PLAN_COLUMNS, type PlanRow } from './planesRepository.js';
import { buildPlannerPrompt } from './prompt.js';
import { buildPlanSchema } from './schema.js';
import type { PlanOutput } from './types.js';

// Generates the weekly plan of a client. Reads through the repositories (always filtered by
// cliente_id), builds the context and prompt (pure, rule 9), calls generateStructured (budget,
// one retry, alert) and stores the plan, its pieces, their fact links and their creation history in
// ONE transaction. Rule 2: every cited fact is re-checked inside that transaction.
// Logs carry ids and counts only: never the prompt, the model output or any idea text.

export const PLAN_PURPOSE = 'plan_semanal';

/** Output budget: about 150 to 300 tokens per piece (an idea of up to 300 characters and up to 5 fact ids) plus the wrapper. */
export function maxOutputTokensFor(pieceCount: number): number {
  return 600 + 300 * pieceCount;
}

export interface PlanificadorDeps {
  db: Db;
  provider: LLMProvider;
  alerts: AlertSink;
  logger?: Logger;
}

export interface GenerarPlanOptions {
  /** Any date of the week: a Date (turned into the client's local date) or YYYY-MM-DD. Normalized to the Monday. */
  semana: Date | string;
  /** Replace the week's plan when it is still a draft (borrador). */
  reemplazar?: boolean;
}

export interface PlanGenerado {
  plan: PlanRow;
  piezas: PiezaRow[];
  generacion: {
    intentos: number;
    costo: MicroUsd;
    piezasPorSemana: number;
    frecuenciaOrigen: 'perfil' | 'defecto';
  };
}

function isActivePlanConflict(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === 'planes_semanales_activo_key';
}

/** The active plan of the week may be replaced only when the caller asks and it is still a draft. */
function assertCanReplace(existing: PlanRow, reemplazar: boolean): void {
  const reemplazable = existing.estado === 'borrador';
  if (!(reemplazable && reemplazar)) throw new PlanExistenteError(existing.id, existing.estado, reemplazable);
}

export async function generarPlanSemanal(
  deps: PlanificadorDeps,
  clienteId: ClienteId,
  options: GenerarPlanOptions,
  actor: AuditActor,
): Promise<PlanGenerado> {
  const { db } = deps;
  const log = deps.logger ?? defaultLogger;
  const reemplazar = options.reemplazar ?? false;

  // 1. Eligibility, before anything is paid for.
  const perfil = await getCurrentPerfilMarca(db, clienteId);
  const completeness = perfil ? await getCompleteness(db, clienteId) : null;
  if (!perfil || !completeness || !completeness.mandatoryComplete) {
    const bloques = completeness
      ? Object.entries(completeness.blocks)
          .filter(([, block]) => block.mandatory && block.percent < 100)
          .map(([bloque, block]) => ({ bloque, faltan: block.missing }))
      : [];
    throw new NoPuedePlanificarError(bloques);
  }

  // 2. The Monday of the week, in the client's zone.
  const zona = (perfil.operacion as Record<string, unknown>).zona_horaria;
  let fechaLocal: string;
  if (options.semana instanceof Date) {
    if (typeof zona !== 'string' || !isValidZone(zona)) throw new PlannerContextError('operacion.zona_horaria');
    fechaLocal = localDateOf(options.semana, zona);
  } else {
    if (!isValidLocalDate(options.semana)) throw new PlannerContextError('semana');
    fechaLocal = options.semana;
  }
  const semanaInicio = mondayOf(fechaLocal);

  // 3. An existing plan is refused now, so nothing is paid for a plan that cannot be stored.
  const existing = await getPlanActivoDeSemana(db, clienteId, semanaInicio);
  if (existing) assertCanReplace(existing, reemplazar);

  // 4. Context and prompt (pure).
  const hechos = (await getValidHechos(db, clienteId)).map((h) => ({
    id: h.id,
    tipo: h.tipo,
    enunciado: h.enunciado,
    vigente_desde: h.vigente_desde,
    vigente_hasta: h.vigente_hasta,
  }));
  const reglas = (await listReglas(db, clienteId)).map((r) => ({ tipo: r.tipo, texto: r.texto }));
  const context = buildPlannerContext({
    perfil: {
      identidad: perfil.identidad,
      pilares: perfil.pilares,
      objetivo: perfil.objetivo,
      operacion: perfil.operacion,
      plan: perfil.plan,
      idioma_contenido: perfil.idioma_contenido,
    },
    hechos,
    reglas,
    semanaInicio,
  });

  // 5. The model call: budget, estimate, authorization, single retry and alert live here.
  const generated = await generateStructured<PlanOutput>(
    { db, provider: deps.provider, alerts: deps.alerts, logger: log },
    {
      clienteId,
      purpose: PLAN_PURPOSE,
      schema: buildPlanSchema(context),
      prompt: buildPlannerPrompt(context),
      maxOutputTokens: maxOutputTokensFor(context.piezasPorSemana),
      actor,
    },
  );

  // 6. One transaction stores everything.
  let stored: { plan: PlanRow; piezas: PiezaRow[] };
  try {
    stored = await runInTransaction(db, async (tx) => {
      // The week again, under lock: another plan may have appeared during the model call.
      const { rows: active } = await tx.query<PlanRow>(
        `SELECT ${PLAN_COLUMNS} FROM planes_semanales WHERE cliente_id = $1 AND semana_inicio = $2::date AND estado <> 'descartado' FOR UPDATE`,
        [clienteId, semanaInicio],
      );
      if (active[0]) {
        assertCanReplace(active[0], reemplazar);
        await tx.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1 AND cliente_id = $2`, [active[0].id, clienteId]);
        await recordAudit(tx, {
          actor,
          accion: 'descartar',
          tabla: 'planes_semanales',
          filaId: active[0].id,
          clienteId,
          antes: { estado: active[0].estado },
          despues: { estado: 'descartado', motivo: 'reemplazado por un plan nuevo' },
        });
      }

      // Rule 2, again: every cited fact must still be valid now and when its piece goes out.
      const citedIds = [...new Set(generated.data.piezas.flatMap((p) => p.hecho_ids))];
      if (citedIds.length > 0) {
        const { rows: fresh } = await tx.query<{ id: string; desde: Date; hasta: Date | null; vigente_ahora: boolean }>(
          `SELECT id, vigente_desde AS desde, vigente_hasta AS hasta,
                  (vigente_desde <= now() AND (vigente_hasta IS NULL OR vigente_hasta > now())) AS vigente_ahora
           FROM hechos_verificados WHERE cliente_id = $1 AND id = ANY($2::uuid[]) FOR SHARE`,
          [clienteId, citedIds],
        );
        const byId = new Map(fresh.map((f) => [f.id, f]));
        const invalid = new Set<string>();
        for (const pieza of generated.data.piezas) {
          for (const id of pieza.hecho_ids) {
            const f = byId.get(id);
            const at = pieza.fechaHoraUtc;
            if (!f || !f.vigente_ahora || f.desde > at || (f.hasta !== null && f.hasta <= at)) invalid.add(id);
          }
        }
        if (invalid.size > 0) throw new HechoVencidoError([...invalid]);
      }

      const { rows: planRows } = await tx.query<{ id: string }>(
        `INSERT INTO planes_semanales (cliente_id, semana_inicio, zona_horaria, estado, perfil_marca_id, creado_por)
         VALUES ($1, $2::date, $3, 'borrador', $4, $5) RETURNING id`,
        [clienteId, semanaInicio, context.zonaHoraria, perfil.id, actor.tipo === 'usuario' ? actor.usuarioId : null],
      );
      const planId = planRows[0]!.id;
      await recordAudit(tx, {
        actor,
        accion: 'crear',
        tabla: 'planes_semanales',
        filaId: planId,
        clienteId,
        despues: {
          semana_inicio: semanaInicio,
          zona_horaria: context.zonaHoraria,
          estado: 'borrador',
          perfil_marca_id: perfil.id,
          piezas: generated.data.piezas.length,
          frecuencia_origen: context.frecuenciaOrigen,
        },
      });

      for (const pieza of generated.data.piezas) {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO piezas (cliente_id, plan_id, red, formato, pilar, trabajo, idea, fecha_hora)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [clienteId, planId, pieza.red, pieza.formato, pieza.pilar, pieza.trabajo, pieza.idea, pieza.fechaHoraUtc],
        );
        const piezaId = rows[0]!.id;
        // The first history row of the piece: creation, version 0.
        await tx.query(
          `INSERT INTO historial_estados_pieza (cliente_id, pieza_id, version, desde, hacia, actor_tipo, actor_usuario_id, motivo)
           VALUES ($1, $2, 0, NULL, 'planeada', $3, $4, 'Pieza creada por el plan semanal')`,
          [clienteId, piezaId, actor.tipo, actor.tipo === 'usuario' ? actor.usuarioId : null],
        );
        for (const hechoId of pieza.hecho_ids) {
          await tx.query('INSERT INTO piezas_hechos (pieza_id, hecho_id, cliente_id) VALUES ($1, $2, $3)', [piezaId, hechoId, clienteId]);
        }
        await recordAudit(tx, {
          actor,
          accion: 'crear',
          tabla: 'piezas',
          filaId: piezaId,
          clienteId,
          // The idea text is deliberately not copied here.
          despues: {
            plan_id: planId,
            red: pieza.red,
            formato: pieza.formato,
            pilar: pieza.pilar,
            trabajo: pieza.trabajo,
            fecha_hora: pieza.fechaHoraUtc.toISOString(),
            estado: 'planeada',
            hecho_ids: pieza.hecho_ids,
          },
        });
      }

      return {
        plan: (await getPlan(tx, clienteId, planId))!,
        piezas: await listPiezas(tx, clienteId, { planId }),
      };
    });
  } catch (error) {
    // A competing insert won the unique index between our check and our insert.
    if (isActivePlanConflict(error)) {
      const winner = await getPlanActivoDeSemana(db, clienteId, semanaInicio);
      if (winner) throw new PlanExistenteError(winner.id, winner.estado, winner.estado === 'borrador');
    }
    throw error;
  }

  log.info(
    { clienteId, planId: stored.plan.id, semana: semanaInicio, piezas: stored.piezas.length, intentos: generated.attempts, costo: generated.cost.toString() },
    'weekly plan stored',
  );
  return {
    ...stored,
    generacion: {
      intentos: generated.attempts,
      costo: generated.cost,
      piezasPorSemana: context.piezasPorSemana,
      frecuenciaOrigen: context.frecuenciaOrigen,
    },
  };
}

