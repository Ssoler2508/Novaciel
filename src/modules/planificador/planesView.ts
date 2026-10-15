import type { PiezaRow } from '../piezas/piezasRepository.js';
import { localDateTimeOf } from './fechas.js';
import type { PlanRow } from './planesRepository.js';

// What the API returns for plans and pieces. Never the prompt (it is not stored) and never anything
// from the model beyond the validated plan fields.

export interface PiezaView {
  id: string;
  plan_id: string;
  red: string;
  formato: string;
  pilar: string;
  /** "Trabajo de la pieza": atraer, confianza or accion. */
  trabajo: string;
  idea: string;
  fecha_hora_utc: string;
  /** The same instant on the wall clock of the plan's zone. */
  fecha_hora_local: { fecha: string; hora: string; zona_horaria: string };
  estado: string;
  estado_previo: string | null;
  hecho_ids: string[];
}

export interface PlanView {
  id: string;
  semana_inicio: string;
  zona_horaria: string;
  estado: string;
  perfil_marca_id: string;
  creado_por: string | null;
  creado_en: Date;
}

export function toPlanView(plan: PlanRow): PlanView {
  return {
    id: plan.id,
    semana_inicio: plan.semana_inicio,
    zona_horaria: plan.zona_horaria,
    estado: plan.estado,
    perfil_marca_id: plan.perfil_marca_id,
    creado_por: plan.creado_por,
    creado_en: plan.creado_en,
  };
}

export function toPiezaView(pieza: PiezaRow, zonaHoraria: string): PiezaView {
  return {
    id: pieza.id,
    plan_id: pieza.plan_id,
    red: pieza.red,
    formato: pieza.formato,
    pilar: pieza.pilar,
    trabajo: pieza.trabajo,
    idea: pieza.idea,
    fecha_hora_utc: pieza.fecha_hora.toISOString(),
    fecha_hora_local: { ...localDateTimeOf(pieza.fecha_hora, zonaHoraria), zona_horaria: zonaHoraria },
    estado: pieza.estado,
    estado_previo: pieza.estado_previo,
    hecho_ids: pieza.hecho_ids,
  };
}
