// Shapes of the approval routes. They match the backend responses exactly; nothing is renamed or
// defaulted here.
import { getJson } from './http.js';

export type NivelAprobacion = 'interno' | 'cliente';

export interface PiezaPendiente {
  id: string;
  red: string;
  formato: string;
  estado: string;
  fecha_hora: string;
  version: number;
  hash_pieza: string;
}

export interface PlanPendiente {
  id: string;
  semana_inicio: string;
  piezas: number;
  primer_plazo: string;
  huella_plan: string;
}

export interface Pendientes {
  nivel: NivelAprobacion;
  piezas: PiezaPendiente[];
  planes: PlanPendiente[];
}

export function getPendientes(clienteId: string): Promise<Pendientes> {
  return getJson<Pendientes>(`/clientes/${encodeURIComponent(clienteId)}/aprobaciones/pendientes`);
}
