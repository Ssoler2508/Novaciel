// Pure types of the weekly planner (no database, no I/O).

/** The networks of conexiones_redes and of piezas.red. */
export const REDES = ['instagram', 'facebook', 'tiktok', 'youtube'] as const;
export type Red = (typeof REDES)[number];

/** The formats of piezas.formato (spec 1, 9.6 and 11.4: short video, carousel, image post, story). */
export const FORMATOS = ['reel', 'carrusel', 'post', 'historia'] as const;
export type Formato = (typeof FORMATOS)[number];

/** "Trabajo de la pieza" (spec 7, rule 2): attract new people, build trust, or ask for the action. */
export const TRABAJOS = ['atraer', 'confianza', 'accion'] as const;
export type Trabajo = (typeof TRABAJOS)[number];

/**
 * Formats each network accepts. Instagram and Facebook take all four (spec 11.4 starts with them);
 * TikTok and YouTube (Shorts) are video-only, so only `reel`.
 */
export const FORMATOS_POR_RED: Record<Red, readonly Formato[]> = {
  instagram: FORMATOS,
  facebook: FORMATOS,
  tiktok: ['reel'],
  youtube: ['reel'],
};

export const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'] as const;
export type Dia = (typeof DIAS)[number];

/** Used when the profile does not say how many pieces a week it wants (plan.piezas_por_semana). */
export const PIEZAS_POR_SEMANA_DEFECTO = 3;
export const PIEZAS_POR_SEMANA_MAX = 14;

export type HechoTipo = 'precio' | 'horario' | 'promocion' | 'cifra' | 'otro';

/** A verified fact as the planner needs it. The caller passes only facts valid now (getValidHechos). */
export interface HechoPlanner {
  id: string;
  tipo: HechoTipo;
  enunciado: string;
  vigente_desde: Date;
  vigente_hasta: Date | null;
}

export type ReglaTipo = 'promesa' | 'tema' | 'palabra' | 'elemento_visual';

export interface ReglaPlanner {
  tipo: ReglaTipo;
  texto: string;
}

/**
 * A vetoed window in the client's LOCAL time, `desde` inclusive and `hasta` exclusive, on one day
 * of the week or (without `dia`) on every day. A window across midnight is written as two entries.
 * The key operacion.horarios_vetados is a PROPOSAL pending confirmation by the Senior: spec 4.3 only
 * says `operacion` holds "horarios vetados".
 */
export interface HorarioVetado {
  dia?: Dia;
  desde: string;
  hasta: string;
}

/** What the planner reads from the client: one client's data only. */
export interface PlannerSnapshot {
  perfil: {
    identidad: Record<string, unknown>;
    pilares: Record<string, unknown>;
    objetivo: Record<string, unknown>;
    operacion: Record<string, unknown>;
    plan: Record<string, unknown>;
    idioma_contenido: 'es' | 'en' | 'ambos' | null;
  };
  hechos: readonly HechoPlanner[];
  reglas: readonly ReglaPlanner[];
  /** The Monday of the week in the client's zone, YYYY-MM-DD. */
  semanaInicio: string;
}

export interface PlannerContext {
  semanaInicio: string;
  /** The 7 local dates of the week, Monday first. */
  dias: readonly string[];
  zonaHoraria: string;
  marca: { nombre: string; descripcion: string };
  idioma: 'es' | 'en' | 'ambos';
  pilares: readonly { nombre: string; peso: number }[];
  plataformas: readonly Red[];
  plataformaPrioritaria: Red | null;
  objetivo: string;
  piezasPorSemana: number;
  /** Where the frequency came from: the profile (plan.piezas_por_semana) or the built-in default. */
  frecuenciaOrigen: 'perfil' | 'defecto';
  hechos: readonly HechoPlanner[];
  reglas: readonly ReglaPlanner[];
  horariosVetados: readonly HorarioVetado[];
}

/** One planned piece, validated, with its UTC instant. */
export interface PlanPieza {
  red: Red;
  formato: Formato;
  pilar: string;
  trabajo: Trabajo;
  /** Local date and time in the client's zone. */
  fecha: string;
  hora: string;
  idea: string;
  hecho_ids: string[];
  fechaHoraUtc: Date;
}

export interface PlanOutput {
  piezas: PlanPieza[];
}
