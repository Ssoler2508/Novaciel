import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelTier, TierModels } from '../../lib/ai/modelTiers.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../lib/ai/types.js';
import { InvalidLocalTimeError } from './errors.js';
import { toUtc } from './fechas.js';
import { buildPlanSchema, isVetado } from './schema.js';
import { containsText, containsWord } from './textMatch.js';
import { FORMATOS_POR_RED, TRABAJOS, type PlannerContext, type Red, type Trabajo } from './types.js';

// A planner for DEVELOPMENT and TESTS: it builds a valid weekly plan from the structured
// PlannerContext, so the whole flow works locally without any API key. It never reads the prompt:
// the context reaches it through AsyncLocalStorage (see PlanificadorDeps.withContext), a side
// channel that exists only for this fake, so nothing the client wrote is ever parsed as instructions.
// Concurrent generations do not mix: each runs inside its own async context.

const contexts = new AsyncLocalStorage<PlannerContext>();

const TIMES = ['10:00', '12:30', '16:00', '18:30', '09:00', '20:00'];

const IDEAS: Record<'es' | 'en', Record<Trabajo, string>> = {
  es: {
    atraer: 'Muestra algo nuevo del negocio a quien aún no lo conoce',
    confianza: 'Cuenta cómo trabajamos para generar confianza',
    accion: 'Invita a la gente a visitarnos esta semana',
  },
  en: {
    atraer: 'Show something new to people who do not know the business yet',
    confianza: 'Explain how we work to build trust',
    accion: 'Invite people to visit us this week',
  },
};

/** Pillar of each piece by largest-remainder rounding of the weights, interleaved over the week. */
function assignPillars(context: PlannerContext): string[] {
  const n = context.piezasPorSemana;
  const total = context.pilares.reduce((sum, p) => sum + p.peso, 0);
  const quotas = context.pilares.map((p, i) => ({ i, exact: (n * p.peso) / total }));
  const counts = quotas.map((q) => Math.floor(q.exact));
  let remaining = n - counts.reduce((a, b) => a + b, 0);
  for (const q of [...quotas].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || a.i - b.i)) {
    if (remaining === 0) break;
    counts[q.i]!++;
    remaining--;
  }
  const sequence: string[] = [];
  while (sequence.length < n) {
    for (let i = 0; i < counts.length && sequence.length < n; i++) {
      if (counts[i]! > 0) {
        sequence.push(context.pilares[i]!.nombre);
        counts[i]!--;
      }
    }
  }
  return sequence;
}

function ideaFor(context: PlannerContext, trabajo: Trabajo, numero: number): string {
  const lang = context.idioma === 'en' ? 'en' : 'es';
  const candidates = [IDEAS[lang][trabajo], lang === 'en' ? `Idea ${numero} of the week` : `Idea ${numero} de la semana`];
  const banned = (text: string) =>
    context.reglas.some((r) => (r.tipo === 'palabra' ? containsWord(text, r.texto) : r.tipo === 'promesa' || r.tipo === 'tema' ? containsText(text, r.texto) : false));
  const idea = candidates.find((c) => !banned(c));
  if (!idea) throw new Error('DeterministicPlannerFake cannot find an idea that avoids the banned terms');
  return `${idea}, pieza ${numero}`;
}

interface Slot {
  fecha: string;
  hora: string;
  instante: Date;
}

/** First free slot at or after the preferred day: a listed time, else any half hour; never vetoed or nonexistent. */
function pickSlot(context: PlannerContext, preferredDay: number, rotation: number, used: Set<string>): Slot {
  const halfHours = Array.from({ length: 48 }, (_v, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`);
  for (const times of [TIMES.map((_t, i) => TIMES[(i + rotation) % TIMES.length]!), halfHours]) {
    for (let offset = 0; offset < 7; offset++) {
      const fecha = context.dias[(preferredDay + offset) % 7]!;
      for (const hora of times) {
        if (used.has(`${fecha} ${hora}`) || isVetado(context, fecha, hora)) continue;
        try {
          return { fecha, hora, instante: toUtc(fecha, hora, context.zonaHoraria) };
        } catch (error) {
          if (!(error instanceof InvalidLocalTimeError)) throw error;
        }
      }
    }
  }
  throw new Error('DeterministicPlannerFake finds no free time in the week');
}

/** The plan, as the JSON object the planner must return. Pure and deterministic. */
export function buildDeterministicPlan(context: PlannerContext) {
  const n = context.piezasPorSemana;
  const pillars = assignPillars(context);
  const networks: Red[] = context.plataformaPrioritaria
    ? [context.plataformaPrioritaria, ...context.plataformas.filter((r) => r !== context.plataformaPrioritaria)]
    : [...context.plataformas];
  const formatCursor = new Map<Red, number>();
  const used = new Set<string>();
  let factCursor = 0;

  const piezas = Array.from({ length: n }, (_v, i) => {
    const red = networks[i % networks.length]!;
    const allowed = FORMATOS_POR_RED[red];
    const cursor = formatCursor.get(red) ?? 0;
    formatCursor.set(red, cursor + 1);
    const trabajo = TRABAJOS[i % TRABAJOS.length]!;
    const slot = pickSlot(context, Math.floor((i * 7) / n), i, used);
    used.add(`${slot.fecha} ${slot.hora}`);

    // Cite one fact that is valid when this piece goes out (round robin), or none.
    const hechoIds: string[] = [];
    for (let k = 0; k < context.hechos.length; k++) {
      const hecho = context.hechos[(factCursor + k) % context.hechos.length]!;
      if (hecho.vigente_desde <= slot.instante && (hecho.vigente_hasta === null || hecho.vigente_hasta > slot.instante)) {
        hechoIds.push(hecho.id);
        factCursor = (factCursor + k + 1) % context.hechos.length;
        break;
      }
    }
    return {
      red,
      formato: allowed[cursor % allowed.length]!,
      pilar: pillars[i]!,
      trabajo,
      fecha: slot.fecha,
      hora: slot.hora,
      idea: ideaFor(context, trabajo, i + 1),
      hecho_ids: hechoIds,
    };
  });
  return { piezas };
}

export class DeterministicPlannerFake implements LLMProvider {
  readonly name = 'fake';
  readonly #models: TierModels;

  constructor(options: { models?: Partial<TierModels> } = {}) {
    this.#models = { heavy: options.models?.heavy ?? 'fake-model', light: options.models?.light ?? 'fake-model-light' };
  }

  modelFor(tier: ModelTier): string {
    return this.#models[tier];
  }

  /** Runs `run` with the planner context available to generate(). The only way the fake learns it. */
  withContext<T>(context: PlannerContext, run: () => Promise<T>): Promise<T> {
    return contexts.run(context, run);
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const context = contexts.getStore();
    if (!context) throw new Error('DeterministicPlannerFake needs a planner context (run it through generarPlanSemanal with withContext)');
    const plan = buildDeterministicPlan(context);
    // A bug in this fake must never reach the database: check its own work with the real schema.
    const check = buildPlanSchema(context).safeParse(plan);
    if (!check.success) {
      throw new Error(`DeterministicPlannerFake built an invalid plan: ${check.error.issues.map((i) => i.message).join(', ')}`);
    }
    const text = JSON.stringify(plan);
    return {
      text,
      // Sizes only: the prompt text itself is never read.
      inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(request)) / 4),
      outputTokens: Math.ceil(text.length / 4),
      model: this.modelFor(request.tier),
      stopReason: 'end_turn',
    };
  }
}
