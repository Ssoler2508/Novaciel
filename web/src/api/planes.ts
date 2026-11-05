import { getJson } from './http.js';

// Field names match the backend views (src/modules/planificador/planesView.ts). They are typed as
// nullable so an unexpected empty value renders as a placeholder instead of breaking the screen.
export interface PlanListItem {
  id: string;
  semana_inicio: string | null;
  zona_horaria: string | null;
  estado: string | null;
  creado_por: string | null;
  creado_en: string | null;
  piezas?: number | null;
}

export interface PlanView {
  id: string;
  semana_inicio: string | null;
  zona_horaria: string | null;
  estado: string | null;
  creado_por: string | null;
  creado_en: string | null;
}

export interface PiezaLocalDateTime {
  fecha: string;
  hora: string;
  zona_horaria: string;
}

export interface PiezaView {
  id: string;
  red: string | null;
  formato: string | null;
  pilar: string | null;
  fecha_hora_utc: string | null;
  fecha_hora_local: PiezaLocalDateTime | null;
  estado: string | null;
}

export interface PlanDetail extends PlanView {
  piezas: PiezaView[];
}

// huella_plan is deliberately absent: checkpoint C never reads, stores or renders a hash.
export interface PlanRevision {
  plan: PlanView;
  piezas: PiezaView[];
}

interface PlanesResponse {
  items?: PlanListItem[] | null;
}

export async function listPlanes(clienteId: string, semana: string | null): Promise<PlanListItem[]> {
  const query = new URLSearchParams();
  if (semana !== null) query.set('semana', semana);
  const suffix = query.toString();
  const path = `/clientes/${encodeURIComponent(clienteId)}/planes${suffix ? `?${suffix}` : ''}`;
  const response = await getJson<PlanesResponse>(path);
  return response.items ?? [];
}

export async function getPlanDetail(clienteId: string, planId: string): Promise<PlanDetail> {
  const path = `/clientes/${encodeURIComponent(clienteId)}/planes/${encodeURIComponent(planId)}`;
  const response = await getJson<PlanDetail>(path);
  return { ...response, piezas: response.piezas ?? [] };
}

export async function getPlanRevision(clienteId: string, planId: string): Promise<PlanRevision> {
  const path = `/clientes/${encodeURIComponent(clienteId)}/planes/${encodeURIComponent(planId)}/revision`;
  // Destructure only the two fields the screen uses; the response's huella_plan never reaches state.
  const { plan, piezas } = await getJson<PlanRevision>(path);
  return { plan, piezas: piezas ?? [] };
}
