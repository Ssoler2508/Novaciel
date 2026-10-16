import { randomUUID } from 'node:crypto';
import { SEED_PROFILE } from '../../src/scripts/seedProfile.js';
import { buildPlannerContext } from '../../src/modules/planificador/context.js';
import type {
  HechoPlanner,
  PlannerContext,
  PlannerSnapshot,
  ReglaPlanner,
} from '../../src/modules/planificador/types.js';

// Fictional data for the pure planner tests. The week starts on Monday 2026-11-02 in New York
// (daylight saving ended on Sunday 2026-11-01, so the whole week is EST, UTC-5).

export const SEMANA = '2026-11-02';

export const HECHO_PRECIO: HechoPlanner = {
  id: randomUUID(),
  tipo: 'precio',
  enunciado: 'El café americano cuesta $6.000 COP.',
  vigente_desde: new Date('2026-10-01T00:00:00Z'),
  vigente_hasta: null,
};
export const HECHO_HORARIO: HechoPlanner = {
  id: randomUUID(),
  tipo: 'horario',
  enunciado: 'Abrimos de lunes a sábado de 7:00 a 19:00.',
  vigente_desde: new Date('2026-10-01T00:00:00Z'),
  vigente_hasta: null,
};
/** Ends on Wednesday 2026-11-04 at 00:00 New York time (05:00 UTC): valid Monday and Tuesday only. */
export const HECHO_PROMO: HechoPlanner = {
  id: randomUUID(),
  tipo: 'promocion',
  enunciado: '2x1 en capuchinos los martes de este mes.',
  vigente_desde: new Date('2026-10-20T00:00:00Z'),
  vigente_hasta: new Date('2026-11-04T05:00:00Z'),
};
export const HECHO_CIFRA: HechoPlanner = {
  id: randomUUID(),
  tipo: 'cifra',
  enunciado: 'Llevamos 8 años sirviendo café de origen colombiano.',
  vigente_desde: new Date('2026-10-01T00:00:00Z'),
  vigente_hasta: null,
};

export const REGLAS: ReglaPlanner[] = [
  { tipo: 'palabra', texto: 'garantizado' },
  { tipo: 'promesa', texto: 'El mejor café de la ciudad' },
  { tipo: 'tema', texto: 'Política' },
  { tipo: 'elemento_visual', texto: 'fondos oscuros' },
];

export function makeSnapshot(
  overrides: {
    operacion?: Record<string, unknown>;
    plan?: Record<string, unknown>;
    pilares?: Record<string, unknown>;
    objetivo?: Record<string, unknown>;
    identidad?: Record<string, unknown>;
    idioma?: 'es' | 'en' | 'ambos' | null;
    hechos?: readonly HechoPlanner[];
    reglas?: readonly ReglaPlanner[];
    semanaInicio?: string;
  } = {},
): PlannerSnapshot {
  return {
    perfil: {
      identidad: overrides.identidad ?? structuredClone(SEED_PROFILE.identidad),
      pilares: overrides.pilares ?? structuredClone(SEED_PROFILE.pilares),
      objetivo: overrides.objetivo ?? structuredClone(SEED_PROFILE.objetivo),
      operacion: { ...structuredClone(SEED_PROFILE.operacion), ...overrides.operacion },
      plan: overrides.plan ?? {},
      idioma_contenido: overrides.idioma === undefined ? 'es' : overrides.idioma,
    },
    hechos: overrides.hechos ?? [HECHO_PRECIO, HECHO_HORARIO, HECHO_PROMO, HECHO_CIFRA],
    reglas: overrides.reglas ?? REGLAS,
    semanaInicio: overrides.semanaInicio ?? SEMANA,
  };
}

export function makeContext(overrides: Parameters<typeof makeSnapshot>[0] = {}): PlannerContext {
  return buildPlannerContext(makeSnapshot(overrides));
}

/** A valid plan for the default context: 3 pieces, one per pillar, all on instagram. */
export function validPlan() {
  return {
    piezas: [
      {
        red: 'instagram',
        formato: 'reel',
        pilar: 'Origen del café',
        trabajo: 'atraer',
        fecha: '2026-11-03',
        hora: '10:00',
        idea: 'Un vistazo al origen de nuestros granos',
        hecho_ids: [] as string[],
      },
      {
        red: 'instagram',
        formato: 'carrusel',
        pilar: 'Repostería artesanal',
        trabajo: 'confianza',
        fecha: '2026-11-05',
        hora: '12:30',
        idea: 'Cómo se hornea nuestra torta de zanahoria',
        hecho_ids: [] as string[],
      },
      {
        red: 'instagram',
        formato: 'historia',
        pilar: 'Vida del barrio',
        trabajo: 'accion',
        fecha: '2026-11-06',
        hora: '16:00',
        idea: 'Pásate hoy por tu café con calma',
        hecho_ids: [] as string[],
      },
    ],
  };
}
