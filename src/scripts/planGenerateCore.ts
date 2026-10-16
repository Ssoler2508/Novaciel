import { PriceNotFoundError } from '../modules/precios/preciosRepository.js';
import { microToUsd } from '../modules/presupuesto/money.js';
import { BudgetRefusedError } from '../modules/presupuesto/presupuestoService.js';
import { SchemaValidationError } from '../modules/ai/generateStructured.js';
import {
  generarPlanSemanal,
  HechoVencidoError,
  localDateTimeOf,
  NoPuedePlanificarError,
  PlanExistenteError,
  PlannerContextError,
  type PlanificadorDeps,
} from '../modules/planificador/index.js';
import type { PlanGenerateArgs } from './planGenerateArgs.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlanGenerateResult {
  ok: boolean;
  /** Lines to print. Only ids, counts, names of enums/pillars, local times and the cost: no idea text. */
  lines: string[];
}

function countBy<T>(items: readonly T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => `${name} ${n}`).join(', ');
}

/**
 * Generates the week's plan through generarPlanSemanal (actor sistema) and reports it. `semana`
 * defaults to next week. The report never contains the prompt, the ideas or any fact or brand text.
 */
export async function runPlanGenerate(
  deps: PlanificadorDeps,
  args: PlanGenerateArgs,
  now: Date = new Date(),
): Promise<PlanGenerateResult> {
  try {
    const result = await generarPlanSemanal(
      deps,
      args.clienteId,
      { semana: args.semana ?? new Date(now.getTime() + 7 * DAY_MS), reemplazar: args.reemplazar },
      { tipo: 'sistema' },
    );
    const { plan, piezas, generacion } = result;
    return {
      ok: true,
      lines: [
        `Plan ${plan.id} (${plan.estado}) for the week of ${plan.semana_inicio}, zone ${plan.zona_horaria}`,
        `frequency: ${generacion.piezasPorSemana} pieces a week (${generacion.frecuenciaOrigen}), attempts: ${generacion.intentos}`,
        `by network: ${countBy(piezas, (p) => p.red)}`,
        `by format: ${countBy(piezas, (p) => p.formato)}`,
        `by pillar: ${countBy(piezas, (p) => p.pilar)}`,
        ...piezas.map((p, i) => {
          const local = localDateTimeOf(p.fecha_hora, plan.zona_horaria);
          return `  ${i + 1}. ${local.fecha} ${local.hora} ${p.red} ${p.formato}`;
        }),
        `cost: USD ${microToUsd(generacion.costo)}`,
      ],
    };
  } catch (error) {
    return { ok: false, lines: [failureLine(error)] };
  }
}

function failureLine(error: unknown): string {
  if (error instanceof NoPuedePlanificarError) {
    const detail = error.bloques.map((b) => `${b.bloque} (${b.faltan.join(', ')})`).join('; ');
    return `Cannot plan yet. Incomplete: ${detail || 'no current profile'}`;
  }
  if (error instanceof PlanExistenteError) {
    return `The week already has a ${error.estado} plan (${error.planId}).${error.reemplazable ? ' Use --reemplazar to replace the draft.' : ''}`;
  }
  if (error instanceof BudgetRefusedError) return `Budget refused: ${error.reason}`;
  if (error instanceof PriceNotFoundError) return 'No price for the model: enter it first (npm run set-price)';
  if (error instanceof SchemaValidationError) return 'The model output was invalid after 2 attempts (an alert was raised)';
  if (error instanceof HechoVencidoError) return `${error.hechoIds.length} cited fact(s) are no longer valid: run it again`;
  if (error instanceof PlannerContextError) return `Profile problem: ${error.field}`;
  return `Plan generation failed (${error instanceof Error ? error.name : 'unknown error'})`;
}
