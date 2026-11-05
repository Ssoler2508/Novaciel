import { getJson } from './http.js';

export interface PlanListItem {
  id: string;
  semana_inicio: string | null;
  zona_horaria: string | null;
  estado: string | null;
  creado_por: string | null;
  creado_en: string | null;
  piezas?: number | null;
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
