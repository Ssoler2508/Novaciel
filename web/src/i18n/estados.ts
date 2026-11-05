// State codes the backend stores, with their Spanish UI labels. The order is the main chain of
// spec section 15. Keep in sync with src/modules/piezas/estados.ts and the estado_pieza domain in
// migration 1700000001200_planes_piezas.sql (read-only sources of truth).
import { es } from './es.js';

export const ESTADOS_PIEZA = [
  'planeada',
  'plan_aprobado',
  'guion_listo',
  'en_produccion',
  'en_control_calidad',
  'revision_novaciel',
  'esperando_aprobacion',
  'aprobada',
  'programada',
  'publicada',
  'en_medicion',
  'cerrada',
  'con_cambios',
  'rechazada',
  'fallo_publicacion',
  'pausada',
] as const;

export type EstadoPieza = (typeof ESTADOS_PIEZA)[number];

export const ESTADOS_PLAN = ['borrador', 'propuesto', 'aprobado', 'descartado'] as const;

export type EstadoPlan = (typeof ESTADOS_PLAN)[number];

// Typed as Record<...>: a missing or extra key in the dictionary is a compile-time error.
export const ETIQUETAS_PIEZA: Record<EstadoPieza, string> = es.estados.pieza;
export const ETIQUETAS_PLAN: Record<EstadoPlan, string> = es.estados.plan;

export type EstadoSistema =
  | { tipo: 'pieza'; estado: EstadoPieza }
  | { tipo: 'plan'; estado: EstadoPlan };

export function esEstadoPieza(value: string): value is EstadoPieza {
  return (ESTADOS_PIEZA as readonly string[]).includes(value);
}

export function esEstadoPlan(value: string): value is EstadoPlan {
  return (ESTADOS_PLAN as readonly string[]).includes(value);
}

export function etiquetaEstadoPieza(estado: EstadoPieza): string {
  return ETIQUETAS_PIEZA[estado];
}

export function etiquetaEstadoPlan(estado: EstadoPlan): string {
  return ETIQUETAS_PLAN[estado];
}

export function etiquetaEstado(estado: EstadoSistema): string {
  return estado.tipo === 'pieza' ? etiquetaEstadoPieza(estado.estado) : etiquetaEstadoPlan(estado.estado);
}

// Approval, quality-control and reason codes: known values are translated, unknown ones are shown
// exactly as the backend sent them (never invent a meaning for a code we do not know).
type LabelMap = Readonly<Record<string, string>>;

function etiqueta(map: LabelMap, value: string | null | undefined): string {
  if (value === null || value === undefined) return es.common.notAvailable;
  const label = map[value];
  if (label !== undefined) return label;
  const trimmed = value.trim();
  return trimmed ? trimmed : es.common.notAvailable;
}

export function etiquetaEstadoAprobacion(value: string | null | undefined): string {
  return etiqueta(es.estados.aprobacion, value);
}

export function etiquetaNivelAprobacion(value: string | null | undefined): string {
  return etiqueta(es.estados.nivelAprobacion, value);
}

export function etiquetaDecisionPieza(value: string | null | undefined): string {
  return etiqueta(es.estados.decisionPieza, value);
}

export function etiquetaMotivoPieza(value: string | null | undefined): string {
  return etiqueta(es.estados.motivoPieza, value);
}

export function etiquetaResultadoQc(value: string | null | undefined): string {
  return etiqueta(es.estados.qcResultado, value);
}

export function etiquetaCheckQc(value: string | null | undefined): string {
  return etiqueta(es.estados.qcCheck, value);
}

export function etiquetaSeveridadQc(value: string | null | undefined): string {
  return etiqueta(es.estados.qcSeveridad, value);
}
