import { z } from 'zod';
import { isValidLocalDate, isValidZone, localDateTimeOf } from '../planificador/fechas.js';
import { limitesDe } from './limits.js';
import { BriefContextError } from './errors.js';
import type { BriefContext, BriefSnapshot, BriefVisual, BriefVoz } from './types.js';

// Pure: builds what the creative director needs from one piece's snapshot. The profile keys read
// here (voz.*, kit_visual.aparecen_personas, kit_visual.estilo_imagen) are the ones listed in
// completeness.ts, which are a PROPOSAL pending confirmation by the Senior. Logos, colours and
// fonts are not read: they belong to the production steps.

const stringList = z.array(z.string()).default([]);
const vozSchema = z
  .object({
    adjetivos: stringList,
    adjetivos_nunca: stringList,
    trato: z.string().default(''),
    frases_propias: stringList,
    emojis: z.string().default(''),
    usa_humor: z.boolean().default(false),
  })
  .passthrough();
const ESTILO_KEYS = ['luminosidad', 'temperatura', 'limpieza', 'produccion'] as const;

function fail(field: string): never {
  throw new BriefContextError(field);
}

function parseVoz(raw: Record<string, unknown>): BriefVoz {
  if (Object.keys(raw).length === 0) fail('voz');
  const parsed = vozSchema.safeParse(raw);
  if (!parsed.success) fail('voz');
  const { adjetivos, adjetivos_nunca, trato, frases_propias, emojis, usa_humor } = parsed.data;
  return { adjetivos, adjetivos_nunca, trato, frases_propias, emojis, usa_humor };
}

function parseVisual(raw: Record<string, unknown>): BriefVisual {
  const aparecen = raw.aparecen_personas;
  if (aparecen !== undefined && typeof aparecen !== 'boolean') fail('kit_visual.aparecen_personas');
  const estilo = raw.estilo_imagen;
  if (estilo !== undefined && (estilo === null || typeof estilo !== 'object' || Array.isArray(estilo))) fail('kit_visual.estilo_imagen');
  const estiloImagen: Record<string, string> = {};
  for (const key of ESTILO_KEYS) {
    const value = (estilo as Record<string, unknown> | undefined)?.[key];
    if (typeof value === 'string' && value.trim() !== '') estiloImagen[key] = value.trim();
  }
  return { aparecen_personas: aparecen ?? false, estilo_imagen: estiloImagen };
}

/**
 * `snapshot.media` is already preselected (selectCandidateMedia); the context keeps it as the only
 * media the model may choose from.
 */
export function buildBriefContext(snapshot: BriefSnapshot): BriefContext {
  const { pieza, perfil } = snapshot;
  if (!isValidZone(snapshot.zonaHoraria)) fail('zona_horaria');
  if (!(pieza.fechaHora instanceof Date) || Number.isNaN(pieza.fechaHora.getTime())) fail('pieza.fecha_hora');
  if (pieza.idea.trim() === '' || pieza.pilar.trim() === '') fail('pieza');
  if (perfil.idioma_contenido === null) fail('idioma_contenido');
  if (new Set(snapshot.media.map((m) => m.id)).size !== snapshot.media.length) fail('media');

  const voz = parseVoz(perfil.voz);
  const visual = parseVisual(perfil.kit_visual);

  const local = localDateTimeOf(pieza.fechaHora, snapshot.zonaHoraria);
  if (!isValidLocalDate(local.fecha)) fail('pieza.fecha_hora');

  const nombre = perfil.identidad.nombre_comercial;
  const descripcion = perfil.identidad.descripcion;
  const citados = new Set(pieza.hechoIds.map((id) => id.toLowerCase()));
  return {
    pieza: {
      id: pieza.id,
      red: pieza.red,
      formato: pieza.formato,
      pilar: pieza.pilar.trim(),
      trabajo: pieza.trabajo,
      idea: pieza.idea.trim(),
      fechaHora: pieza.fechaHora,
      fecha: local.fecha,
      hora: local.hora,
      zonaHoraria: snapshot.zonaHoraria,
    },
    marca: {
      nombre: typeof nombre === 'string' ? nombre.trim() : '',
      descripcion: typeof descripcion === 'string' ? descripcion.trim() : '',
    },
    idioma: perfil.idioma_contenido,
    voz,
    visual,
    hechos: snapshot.hechos.map((h) => ({ ...h, citado: citados.has(h.id.toLowerCase()) })),
    reglas: snapshot.reglas.map((r) => ({ ...r })),
    candidatos: snapshot.media.map((m) => ({ ...m, etiquetas: [...m.etiquetas] })),
    limites: limitesDe(pieza.formato),
  };
}
