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

export type EstadoAprobacionCodigo =
  | 'pendiente_interno'
  | 'pendiente_cliente'
  | 'cambios_pedidos'
  | 'rechazada'
  | 'aprobada';

export interface EstadoAprobacion {
  estado: EstadoAprobacionCodigo;
  ronda?: number;
}

export type DecisionPieza = 'aprobada' | 'cambios' | 'rechazada';
export type MotivoPieza = 'texto' | 'musica' | 'toma' | 'gancho' | 'dato_equivocado' | 'otro';
export type ResultadoControlCalidad = 'aprobado' | 'rechazado';

/** Only the video fields the screen displays; fuentes are internal and never typed here. */
export interface VideoRevision {
  duracion_ms: number;
  fps: number;
}

export interface ArchivoRevision {
  orden: number;
  mime: string;
  video: VideoRevision | null;
  url: string;
  url_expira_en_s: number;
}

export interface EntradaHistorial {
  nivel: 'interno' | 'cliente';
  decision: DecisionPieza;
  motivo: MotivoPieza | null;
  version: number;
  creado_en: string;
  propia: boolean;
  comentario: string | null;
}

export interface ControlCalidad {
  resultado: ResultadoControlCalidad;
  version: number;
  creado_en: string;
}

export interface Revision {
  id: string;
  version: number;
  red: string;
  texto_publicacion: string;
  hashtags: string[];
  textos_alternativos: string[];
  ubicacion: string | null;
  /** Kept in state for the decision screen; never rendered. */
  hash_pieza: string;
  archivos: ArchivoRevision[];
  pieza_estado: string;
  fecha_hora: string;
  estado_aprobacion: EstadoAprobacion;
  historial: EntradaHistorial[];
  control_calidad: ControlCalidad | null;
}

export function getRevision(clienteId: string, piezaId: string): Promise<Revision> {
  return getJson<Revision>(
    `/clientes/${encodeURIComponent(clienteId)}/piezas/${encodeURIComponent(piezaId)}/revision`,
  );
}
