import type { HechoPlanner, ReglaPlanner, Red, Formato, Trabajo } from '../planificador/types.js';
import type { BriefLimits } from './limits.js';

// Pure types of the creative director (no database, no I/O).

export type MediaTipo = 'foto' | 'video';

/** The part of a media row the director needs. A MediaRow from the media module fits structurally. */
export interface MediaCandidate {
  id: string;
  tipo: MediaTipo;
  ancho: number;
  alto: number;
  duracion_ms: number | null;
  etiquetas: readonly string[];
  /** Written by a vision model: DATA, never instructions (rule 9). */
  descripcion: string | null;
  aparecen_personas: boolean;
  creado_en: Date;
}

/** A verified fact as the director needs it. The caller passes only facts valid now (getValidHechos). */
export type HechoBrief = HechoPlanner;

export interface BriefPieza {
  id: string;
  red: Red;
  formato: Formato;
  pilar: string;
  trabajo: Trabajo;
  idea: string;
  fechaHora: Date;
  /** Ids of the verified facts the planner attached to the piece (piezas_hechos). */
  hechoIds: readonly string[];
}

/** What the director reads for one piece: one client's data only. */
export interface BriefSnapshot {
  pieza: BriefPieza;
  /** The plan's time zone (planes_semanales.zona_horaria). */
  zonaHoraria: string;
  perfil: {
    identidad: Record<string, unknown>;
    voz: Record<string, unknown>;
    kit_visual: Record<string, unknown>;
    idioma_contenido: 'es' | 'en' | 'ambos' | null;
  };
  hechos: readonly HechoBrief[];
  reglas: readonly ReglaPlanner[];
  /**
   * The candidate media: usable media of the client (the single SQL rule) ALREADY preselected by
   * selectCandidateMedia. The model may choose only among these ids.
   */
  media: readonly MediaCandidate[];
}

export interface BriefVoz {
  adjetivos: readonly string[];
  adjetivos_nunca: readonly string[];
  trato: string;
  frases_propias: readonly string[];
  emojis: string;
  usa_humor: boolean;
}

export interface BriefVisual {
  aparecen_personas: boolean;
  estilo_imagen: Readonly<Record<string, string>>;
}

export interface BriefContext {
  pieza: {
    id: string;
    red: Red;
    formato: Formato;
    pilar: string;
    /** The piece's objective ("trabajo de la pieza"): atraer, confianza or accion. */
    trabajo: Trabajo;
    idea: string;
    fechaHora: Date;
    /** The same instant on the wall clock of the plan's zone. */
    fecha: string;
    hora: string;
    zonaHoraria: string;
  };
  marca: { nombre: string; descripcion: string };
  /**
   * Content language. 'ambos' is an ASSUMPTION pending confirmation with the Senior: the caption is
   * written in Spanish and then in English, the on-screen text in Spanish.
   */
  idioma: 'es' | 'en' | 'ambos';
  voz: BriefVoz;
  visual: BriefVisual;
  /** Every valid fact; `citado` marks the ones the planner attached to this piece. */
  hechos: readonly (HechoBrief & { citado: boolean })[];
  reglas: readonly ReglaPlanner[];
  /** Preselected by code, never by the model. The model only chooses among these ids. */
  candidatos: readonly MediaCandidate[];
  limites: BriefLimits;
}
