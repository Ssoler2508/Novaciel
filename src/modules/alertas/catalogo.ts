import { z } from 'zod';
import type { VoiceErrorKind } from '../../lib/ai/voice/types.js';
import type { Plantilla } from '../../lib/notificaciones/types.js';
import type { CapaTextoRazon, RemotionNoDisponibleError } from '../produccion/errors.js';

// The alert catalogue (Step 11, approved in checkpoint A; the table is in docs/PLAN.md). Per code: severity,
// whether it carries a client, the zod schema of its parameters (ids, codes and numbers only: never client
// text), the dedupe key, and who is notified. Parameter keys are snake_case, like the other JSON stored.

export type Severidad = 'info' | 'aviso' | 'critica';

const id = z.uuid();
const periodo = z.string().regex(/^\d{4}-\d{2}-01$/);
const codigo = z.string().regex(/^[A-Za-z0-9_.:/-]{1,100}$/);
const instante = z.iso.datetime();

// voz_fallo and capa_texto_fallo come from two places, so each takes one of two strict shapes:
//  - QC: a report failed with these codes (dedupe per production: voz:{produccionId} / capa:{produccionId});
//  - production: the provider or the text engine failed WHILE producing. No production row exists yet, so the
//    attempt is identified by the piece and the instant the attempt started (dedupe per attempt:
//    voz:intento:{piezaId}:{intento_en} / capa:intento:{piezaId}:{intento_en}). Closed codes only, never text.
const VOZ_TIPOS = ['auth', 'quota', 'rate_limit', 'bad_request', 'server', 'timeout'] as const satisfies readonly VoiceErrorKind[];
const CAPA_RAZONES = [
  'paquete_ausente',
  'navegador_ausente',
  'entrada_invalida',
  'fallo_de_bundle',
  'fallo_de_render',
  'tiempo_agotado',
  'salida_incompleta',
  'solicitud_externa',
] as const satisfies readonly (CapaTextoRazon | RemotionNoDisponibleError['razon'])[];

const fueraDeQc = z.object({ pieza_id: id, produccion_id: id, codigos: z.array(codigo).max(20) }).strict();
const vozDeProduccion = z.object({ pieza_id: id, intento_en: instante, tipo: z.enum(VOZ_TIPOS) }).strict();
const capaDeProduccion = z.object({ pieza_id: id, intento_en: instante, razon: z.enum(CAPA_RAZONES) }).strict();

/** QC failure codes that mean the voice-over is broken. */
export const CODIGOS_FALLO_VOZ: readonly string[] = ['voz_audio_ausente', 'voz_volumen_fuera_de_rango'];
/** QC failure codes that mean the text layer of a reel is broken: subtitles, their template, the brand glyphs. */
export const CODIGOS_FALLO_CAPA_TEXTO: readonly string[] = ['voz_subtitulos_ausentes', 'plantilla_invalida', 'marca_glifos_no_soportados'];

/** Splits the failed QC codes into the ones that mean a voice failure and the ones that mean a text-layer failure. */
export function fallosDeVozYCapa(fallos: readonly string[]): { voz: string[]; capa: string[] } {
  return { voz: fallos.filter((c) => CODIGOS_FALLO_VOZ.includes(c)), capa: fallos.filter((c) => CODIGOS_FALLO_CAPA_TEXTO.includes(c)) };
}

interface Definicion {
  severidad: Severidad;
  /** "global": no client (cliente_id NULL). "cliente": needs one. */
  ambito: 'cliente' | 'global';
  parametros: z.ZodType<Record<string, unknown>>;
  clave: (clienteId: string | null, parametros: Record<string, unknown>) => string;
  /** The Notifier is called for NovaCiel staff, and for these client recipients, each with their template. */
  notifica: { novaciel: boolean; cliente?: { quienes: 'duenos' | 'aprobadores'; plantilla: Plantilla } };
}

function def<T extends z.ZodType>(d: {
  severidad: Severidad;
  ambito: 'cliente' | 'global';
  parametros: T;
  clave: (clienteId: string | null, parametros: z.infer<T>) => string;
  notifica: Definicion['notifica'];
}): Definicion {
  return d as unknown as Definicion;
}

function umbral(n: 50 | 80 | 100, severidad: Severidad, cliente?: { quienes: 'duenos' | 'aprobadores'; plantilla: Plantilla }): Definicion {
  return def({
    severidad,
    ambito: 'cliente',
    parametros: z.object({ periodo, umbral: z.literal(n), porcentaje: z.number().min(0).max(100_000) }).strict(),
    clave: (clienteId, p) => `presupuesto:${clienteId}:${p.periodo}:${p.umbral}`,
    notifica: cliente ? { novaciel: true, cliente } : { novaciel: true },
  });
}

const esquema = z
  .object({ proposito: codigo, proveedor: codigo, modelo: codigo, intentos: z.number().int().min(1).max(10), referencia_id: id })
  .strict();
const claveEsquema = (clienteId: string | null, p: z.infer<typeof esquema>) => `schema:${clienteId}:${p.proposito}:${p.referencia_id}`;

export const CATALOGO = {
  presupuesto_umbral_50: umbral(50, 'info'),
  presupuesto_umbral_80: umbral(80, 'aviso'),
  // The client owner is told with a template that has no figures (spec 13.1).
  presupuesto_umbral_100: umbral(100, 'critica', { quienes: 'duenos', plantilla: 'presupuesto_techo_cliente' }),
  interruptor_global_apagado: def({
    severidad: 'critica',
    ambito: 'global',
    parametros: z.object({ actualizado_en: instante }).strict(),
    clave: (_c, p) => `interruptor_global:${p.actualizado_en}`,
    notifica: { novaciel: true },
  }),
  interruptor_cliente_apagado: def({
    severidad: 'aviso',
    ambito: 'cliente',
    parametros: z.object({ actualizado_en: instante }).strict(),
    clave: (clienteId, p) => `interruptor_cliente:${clienteId}:${p.actualizado_en}`,
    notifica: { novaciel: true },
  }),
  trabajo_fallido: def({
    severidad: 'aviso',
    ambito: 'global',
    parametros: z.object({ cola: codigo, job_id: codigo, nombre_error: codigo }).strict(),
    clave: (_c, p) => `trabajo:${p.cola}:${p.job_id}`,
    notifica: { novaciel: true },
  }),
  llm_schema_invalid: def({ severidad: 'aviso', ambito: 'cliente', parametros: esquema, clave: claveEsquema, notifica: { novaciel: true } }),
  vision_schema_invalid: def({ severidad: 'aviso', ambito: 'cliente', parametros: esquema, clave: claveEsquema, notifica: { novaciel: true } }),
  aprobacion_vencida: def({
    severidad: 'aviso',
    ambito: 'cliente',
    parametros: z.object({ tipo: z.enum(['pieza', 'plan']), objeto_id: id, plazo: instante }).strict(),
    clave: (_c, p) => `aprobacion_vencida:${p.tipo}:${p.objeto_id}:${p.plazo}`,
    notifica: { novaciel: true, cliente: { quienes: 'aprobadores', plantilla: 'aprobacion_vencida' } },
  }),
  // Step 9's escalada_cambios notice already tells NovaCiel, so this alert does not notify again.
  aprobacion_escalada: def({
    severidad: 'critica',
    ambito: 'cliente',
    parametros: z.object({ pieza_id: id }).strict(),
    clave: (_c, p) => `escalada:${p.pieza_id}`,
    notifica: { novaciel: false },
  }),
  qc_rechazada: def({
    severidad: 'info',
    ambito: 'cliente',
    parametros: z.object({ pieza_id: id, revision_id: id, codigos_fallo: z.array(codigo).max(100) }).strict(),
    clave: (_c, p) => `qc:${p.revision_id}`,
    notifica: { novaciel: true },
  }),
  voz_fallo: def({
    severidad: 'critica',
    ambito: 'cliente',
    parametros: z.union([fueraDeQc, vozDeProduccion]),
    clave: (_c, p) => ('produccion_id' in p ? `voz:${p.produccion_id}` : `voz:intento:${p.pieza_id}:${p.intento_en}`),
    notifica: { novaciel: true },
  }),
  capa_texto_fallo: def({
    severidad: 'critica',
    ambito: 'cliente',
    parametros: z.union([fueraDeQc, capaDeProduccion]),
    clave: (_c, p) => ('produccion_id' in p ? `capa:${p.produccion_id}` : `capa:intento:${p.pieza_id}:${p.intento_en}`),
    notifica: { novaciel: true },
  }),
  // ---- Step 10: publishing. Ids, closed codes and numbers only: never a caption or a provider message. ----
  // `motivo` is a closed category of the retry policy or a fixed reason of the service (for example
  // "archivo_alterado_al_enviar"). Deduplicated per production and reason.
  publicacion_fallida: def({
    severidad: 'critica',
    ambito: 'cliente',
    parametros: z.object({ pieza_id: id, produccion_id: id, motivo: codigo }).strict(),
    clave: (_c, p) => `publicacion_fallida:${p.produccion_id}:${p.motivo}`,
    notifica: { novaciel: true },
  }),
  publicacion_resultado_desconocido: def({
    severidad: 'critica',
    ambito: 'cliente',
    parametros: z.object({ pieza_id: id, produccion_id: id }).strict(),
    clave: (_c, p) => `publicacion_desconocida:${p.produccion_id}`,
    notifica: { novaciel: true },
  }),
  publicacion_sin_aprobacion: def({
    severidad: 'aviso',
    ambito: 'cliente',
    parametros: z.object({ pieza_id: id, fecha_hora: instante, reprogramaciones: z.number().int().min(1).max(100) }).strict(),
    clave: (_c, p) => `publicacion_sin_aprobacion:${p.pieza_id}:${p.fecha_hora}`,
    notifica: { novaciel: true },
  }),
  publicacion_reprogramaciones_agotadas: def({
    severidad: 'critica',
    ambito: 'cliente',
    parametros: z.object({ pieza_id: id, fecha_hora: instante }).strict(),
    clave: (_c, p) => `publicacion_reprogramaciones:${p.pieza_id}:${p.fecha_hora}`,
    notifica: { novaciel: true },
  }),
  conexion_red_vencida: def({
    severidad: 'critica',
    ambito: 'cliente',
    parametros: z.object({ red: z.enum(['instagram', 'facebook', 'tiktok', 'youtube']), conexion_id: id.optional() }).strict(),
    clave: (clienteId, p) => `conexion_red_vencida:${clienteId}:${p.red}:${p.conexion_id ?? 'ninguna'}`,
    notifica: { novaciel: true },
  }),
  etiqueta_ia_no_soportada: def({
    severidad: 'aviso',
    ambito: 'cliente',
    parametros: z.object({ pieza_id: id, produccion_id: id, proveedor: codigo, red: z.enum(['instagram', 'facebook', 'tiktok', 'youtube']) }).strict(),
    clave: (_c, p) => `etiqueta_ia_no_soportada:${p.produccion_id}`,
    notifica: { novaciel: true },
  }),
} as const satisfies Record<string, Definicion>;

export type CodigoAlerta = keyof typeof CATALOGO;
export const CODIGOS_ALERTA = Object.keys(CATALOGO) as CodigoAlerta[];
export const isCodigoAlerta = (value: string): value is CodigoAlerta => Object.hasOwn(CATALOGO, value);
