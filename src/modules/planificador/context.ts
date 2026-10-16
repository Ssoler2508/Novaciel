import { z } from 'zod';
import { PlannerContextError } from './errors.js';
import { isValidLocalDate, isValidLocalTime, isValidZone, minutesOf, mondayOf, weekDates } from './fechas.js';
import { fold } from './textMatch.js';
import {
  DIAS,
  PIEZAS_POR_SEMANA_DEFECTO,
  PIEZAS_POR_SEMANA_MAX,
  REDES,
  type Dia,
  type HorarioVetado,
  type PlannerContext,
  type PlannerSnapshot,
  type Red,
} from './types.js';

// Pure: builds what the planner needs from one client's snapshot. The profile's JSON keys are a
// PROPOSAL pending confirmation by the Senior (see completeness.ts); the new ones read here are
// plan.piezas_por_semana and operacion.horarios_vetados, both optional.

const nonEmpty = z.string().trim().min(1);

const temasSchema = z.array(z.object({ nombre: nonEmpty, peso: z.number().finite().positive() }).passthrough()).min(1);
const plataformasSchema = z.array(z.object({ plataforma: z.string() }).passthrough());
const frecuenciaSchema = z.number().int().min(1).max(PIEZAS_POR_SEMANA_MAX);
const vetadoSchema = z.object({ dia: z.string().optional(), desde: z.string(), hasta: z.string() }).strict();

function fail(field: string): never {
  throw new PlannerContextError(field);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(field);
  return result.data;
}

function parseHorariosVetados(value: unknown): HorarioVetado[] {
  if (value === undefined) return []; // key absent: no restriction
  const raw = parse(z.array(vetadoSchema), value, 'operacion.horarios_vetados');
  return raw.map((entry) => {
    const dia = entry.dia === undefined ? undefined : DIAS.find((d) => d === fold(entry.dia!));
    if (entry.dia !== undefined && !dia) fail('operacion.horarios_vetados');
    // Same-day windows only, from < to; a window across midnight is two entries.
    if (!isValidLocalTime(entry.desde) || !isValidLocalTime(entry.hasta) || minutesOf(entry.desde) >= minutesOf(entry.hasta)) {
      fail('operacion.horarios_vetados');
    }
    return { ...(dia ? { dia: dia as Dia } : {}), desde: entry.desde, hasta: entry.hasta };
  });
}

export function buildPlannerContext(snapshot: PlannerSnapshot): PlannerContext {
  const { perfil } = snapshot;

  if (!isValidLocalDate(snapshot.semanaInicio) || mondayOf(snapshot.semanaInicio) !== snapshot.semanaInicio) fail('semana');

  const zonaHoraria = parse(nonEmpty, perfil.operacion.zona_horaria, 'operacion.zona_horaria');
  if (!isValidZone(zonaHoraria)) fail('operacion.zona_horaria');

  // Pillars and their weights.
  const temas = parse(temasSchema, perfil.pilares.temas, 'pilares.temas');
  const nombres = new Set(temas.map((t) => fold(t.nombre)));
  if (nombres.size !== temas.length) fail('pilares.temas');
  const pilares = temas.map((t) => ({ nombre: t.nombre.trim(), peso: t.peso }));

  // Platforms: only the networks a piece can be planned for; unsupported ones are ignored.
  const declaradas = parse(plataformasSchema, perfil.operacion.plataformas, 'operacion.plataformas');
  const plataformas: Red[] = [];
  for (const entry of declaradas) {
    const red = REDES.find((r) => r === fold(entry.plataforma).trim());
    if (red && !plataformas.includes(red)) plataformas.push(red);
  }
  if (plataformas.length === 0) fail('operacion.plataformas');
  const prioritaria = typeof perfil.operacion.plataforma_prioritaria === 'string' ? fold(perfil.operacion.plataforma_prioritaria).trim() : '';
  const plataformaPrioritaria = plataformas.find((r) => r === prioritaria) ?? null;

  const objetivo = parse(nonEmpty, perfil.objetivo.objetivo_90_dias, 'objetivo.objetivo_90_dias');
  if (perfil.idioma_contenido === null) fail('idioma_contenido');

  // Frequency: plan.piezas_por_semana (1 to 14) when present, otherwise the documented default.
  const piezasDelPerfil = perfil.plan.piezas_por_semana;
  const piezasPorSemana = piezasDelPerfil === undefined ? PIEZAS_POR_SEMANA_DEFECTO : parse(frecuenciaSchema, piezasDelPerfil, 'plan.piezas_por_semana');

  const nombreComercial = perfil.identidad.nombre_comercial;
  const descripcion = perfil.identidad.descripcion;
  return {
    semanaInicio: snapshot.semanaInicio,
    dias: weekDates(snapshot.semanaInicio),
    zonaHoraria,
    marca: {
      nombre: typeof nombreComercial === 'string' ? nombreComercial.trim() : '',
      descripcion: typeof descripcion === 'string' ? descripcion.trim() : '',
    },
    idioma: perfil.idioma_contenido,
    pilares,
    plataformas,
    plataformaPrioritaria,
    objetivo,
    piezasPorSemana,
    frecuenciaOrigen: piezasDelPerfil === undefined ? 'defecto' : 'perfil',
    hechos: snapshot.hechos.map((h) => ({ ...h })),
    reglas: snapshot.reglas.map((r) => ({ ...r })),
    horariosVetados: parseHorariosVetados(perfil.operacion.horarios_vetados),
  };
}
