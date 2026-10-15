import { z } from 'zod';
import { InvalidLocalTimeError } from './errors.js';
import { diaDeLaSemana, isValidLocalDate, isValidLocalTime, minutesOf, toUtc } from './fechas.js';
import { containsText, containsWord, mentionsPrice, mentionsPromotion, mentionsSchedule } from './textMatch.js';
import {
  FORMATOS,
  FORMATOS_POR_RED,
  TRABAJOS,
  type HechoTipo,
  type PlanOutput,
  type PlanPieza,
  type PlannerContext,
  type Red,
} from './types.js';

// The output schema of the planner, built from the context so that semantic mistakes (a made-up
// pillar, a fact that is not valid, a vetoed hour...) fail validation and use the single retry of
// generateStructured. Each rule reports its own issue message, a stable code, never content.

export const PLAN_ISSUES = {
  formatNotAllowedForNetwork: 'format_not_allowed_for_network',
  unknownPillar: 'unknown_pillar',
  dateOutsideWeek: 'date_outside_week',
  invalidLocalTime: 'invalid_local_time',
  vetoedTime: 'vetoed_time',
  wrongPieceCount: 'wrong_piece_count',
  pillarMix: 'pillar_mix',
  unknownFact: 'unknown_fact',
  factNotValidAtTime: 'fact_not_valid_at_time',
  duplicateFact: 'duplicate_fact',
  missingFactForPrice: 'missing_fact_for_price',
  missingFactForSchedule: 'missing_fact_for_schedule',
  missingFactForPromotion: 'missing_fact_for_promotion',
  bannedTerm: 'banned_term',
} as const;

/** True when a local date and time fall inside one of the client's vetoed windows (end exclusive). */
export function isVetado(context: PlannerContext, fecha: string, hora: string): boolean {
  const dia = diaDeLaSemana(fecha);
  const minutos = minutesOf(hora);
  return context.horariosVetados.some(
    (v) => (v.dia === undefined || v.dia === dia) && minutos >= minutesOf(v.desde) && minutos < minutesOf(v.hasta),
  );
}

/** Allowed distance, in pieces, between a pillar's count and its expected share: max(1, ceil(0.2 * N)). */
export function pillarTolerance(pieceCount: number): number {
  return Math.max(1, Math.ceil(0.2 * pieceCount));
}

export function buildPlanSchema(context: PlannerContext): z.ZodType<PlanOutput> {
  const pieceSchema = z
    .object({
      red: z.enum(context.plataformas as unknown as [Red, ...Red[]]),
      formato: z.enum(FORMATOS),
      pilar: z.string().trim().min(1),
      trabajo: z.enum(TRABAJOS),
      fecha: z.string(),
      hora: z.string(),
      idea: z.string().trim().min(1).max(300),
      hecho_ids: z.array(z.uuid()).max(5),
    })
    .strict();

  const pilaresPorNombre = new Map(context.pilares.map((p) => [p.nombre, p]));
  const hechosPorId = new Map(context.hechos.map((h) => [h.id, h]));
  const totalPeso = context.pilares.reduce((sum, p) => sum + p.peso, 0);

  return z
    .object({ piezas: z.array(pieceSchema) })
    .strict()
    .superRefine((plan, ctx) => {
      const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });

      if (plan.piezas.length !== context.piezasPorSemana) issue(['piezas'], PLAN_ISSUES.wrongPieceCount);

      const counts = new Map<string, number>();
      plan.piezas.forEach((pieza, i) => {
        const at = (field: string) => ['piezas', i, field];

        if (!FORMATOS_POR_RED[pieza.red].includes(pieza.formato)) issue(at('formato'), PLAN_ISSUES.formatNotAllowedForNetwork);

        if (pilaresPorNombre.has(pieza.pilar)) counts.set(pieza.pilar, (counts.get(pieza.pilar) ?? 0) + 1);
        else issue(at('pilar'), PLAN_ISSUES.unknownPillar);

        // Date and time: inside the week, a real local time that exists in the client's zone, not vetoed.
        let instante: Date | null = null;
        if (!isValidLocalDate(pieza.fecha) || !context.dias.includes(pieza.fecha)) {
          issue(at('fecha'), PLAN_ISSUES.dateOutsideWeek);
        } else if (!isValidLocalTime(pieza.hora)) {
          issue(at('hora'), PLAN_ISSUES.invalidLocalTime);
        } else {
          try {
            instante = toUtc(pieza.fecha, pieza.hora, context.zonaHoraria);
          } catch (error) {
            if (!(error instanceof InvalidLocalTimeError)) throw error;
            issue(at('hora'), PLAN_ISSUES.invalidLocalTime);
          }
          const vetado = isVetado(context, pieza.fecha, pieza.hora);
          if (vetado) issue(at('hora'), PLAN_ISSUES.vetoedTime);
        }

        // Cited facts: they must be among the valid facts given, and valid when the piece goes out.
        const citedTypes = new Set<HechoTipo>();
        if (new Set(pieza.hecho_ids).size !== pieza.hecho_ids.length) issue(at('hecho_ids'), PLAN_ISSUES.duplicateFact);
        pieza.hecho_ids.forEach((id, j) => {
          const hecho = hechosPorId.get(id);
          if (!hecho) return issue(['piezas', i, 'hecho_ids', j], PLAN_ISSUES.unknownFact);
          citedTypes.add(hecho.tipo);
          if (instante && (hecho.vigente_desde > instante || (hecho.vigente_hasta !== null && hecho.vigente_hasta <= instante))) {
            issue(['piezas', i, 'hecho_ids', j], PLAN_ISSUES.factNotValidAtTime);
          }
        });

        // A price, schedule or promotion in the idea must come with a fact of that type (rule 2).
        if (mentionsPrice(pieza.idea) && !citedTypes.has('precio')) issue(at('idea'), PLAN_ISSUES.missingFactForPrice);
        if (mentionsSchedule(pieza.idea) && !citedTypes.has('horario')) issue(at('idea'), PLAN_ISSUES.missingFactForSchedule);
        if (mentionsPromotion(pieza.idea) && !citedTypes.has('promocion')) issue(at('idea'), PLAN_ISSUES.missingFactForPromotion);

        // Banned words (whole word), promises and topics (anywhere), accent- and case-insensitive.
        const banned = context.reglas.some((regla) => {
          if (regla.tipo === 'palabra') return containsWord(pieza.idea, regla.texto);
          if (regla.tipo === 'promesa' || regla.tipo === 'tema') return containsText(pieza.idea, regla.texto);
          return false; // elemento_visual belongs to the visual steps
        });
        if (banned) issue(at('idea'), PLAN_ISSUES.bannedTerm);
      });

      // Pillar mix close to the weights, once every piece has a known pillar.
      if (plan.piezas.length > 0 && counts.size > 0 && [...counts.values()].reduce((a, b) => a + b, 0) === plan.piezas.length) {
        const tolerance = pillarTolerance(plan.piezas.length);
        for (const pilar of context.pilares) {
          const expected = (plan.piezas.length * pilar.peso) / totalPeso;
          if (Math.abs((counts.get(pilar.nombre) ?? 0) - expected) > tolerance) {
            issue(['piezas'], PLAN_ISSUES.pillarMix);
            break;
          }
        }
      }
    })
    .transform(
      (plan): PlanOutput => ({
        piezas: plan.piezas.map(
          (p): PlanPieza => ({ ...p, fechaHoraUtc: toUtc(p.fecha, p.hora, context.zonaHoraria) }),
        ),
      }),
    );
}

