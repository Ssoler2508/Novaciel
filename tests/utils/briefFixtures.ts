import { randomUUID } from 'node:crypto';
import { SEED_PROFILE } from '../../src/scripts/seedProfile.js';
import { buildBriefContext } from '../../src/modules/directorCreativo/context.js';
import type { BriefContent } from '../../src/modules/directorCreativo/schema.js';
import type { BriefContext, BriefSnapshot, MediaCandidate } from '../../src/modules/directorCreativo/types.js';
import type { Formato, HechoPlanner, ReglaPlanner, Trabajo } from '../../src/modules/planificador/types.js';
import { HECHO_CIFRA, HECHO_HORARIO, HECHO_PRECIO, HECHO_PROMO, REGLAS } from './plannerFixtures.js';

// Fictional data for the pure creative-director tests. The piece goes out on Tuesday 2026-11-03 at
// 10:00 in New York (EST, UTC-5), i.e. 15:00 UTC. HECHO_PROMO is valid then and stops being valid
// on Wednesday 2026-11-04 at 00:00 New York time.

export const PIEZA_INSTANTE = new Date('2026-11-03T15:00:00Z');
export { HECHO_CIFRA, HECHO_HORARIO, HECHO_PRECIO, HECHO_PROMO, REGLAS };

export function makeMedia(overrides: Partial<MediaCandidate> & { n?: number } = {}): MediaCandidate {
  const { n = 0, ...rest } = overrides;
  const tipo = rest.tipo ?? 'foto';
  return {
    id: randomUUID(),
    tipo,
    ancho: tipo === 'foto' ? 1080 : 1080,
    alto: tipo === 'foto' ? 1350 : 1920,
    duracion_ms: tipo === 'video' ? 20_000 : null,
    etiquetas: [],
    descripcion: null,
    aparecen_personas: false,
    creado_en: new Date(Date.UTC(2026, 9, 1 + n)),
    ...rest,
  };
}

/** Six photos and two videos with no tags. */
export function makeLibrary(): MediaCandidate[] {
  return [
    ...Array.from({ length: 6 }, (_v, n) => makeMedia({ n, tipo: 'foto' })),
    ...Array.from({ length: 2 }, (_v, n) => makeMedia({ n: 10 + n, tipo: 'video' })),
  ];
}

export interface BriefSnapshotOverrides {
  formato?: Formato;
  red?: 'instagram' | 'facebook' | 'tiktok' | 'youtube';
  trabajo?: Trabajo;
  pilar?: string;
  idea?: string;
  hechoIds?: readonly string[];
  hechos?: readonly HechoPlanner[];
  reglas?: readonly ReglaPlanner[];
  media?: readonly MediaCandidate[];
  idioma?: 'es' | 'en' | 'ambos' | null;
  voz?: Record<string, unknown>;
  kitVisual?: Record<string, unknown>;
  identidad?: Record<string, unknown>;
  zonaHoraria?: string;
  fechaHora?: Date;
}

export function makeBriefSnapshot(o: BriefSnapshotOverrides = {}): BriefSnapshot {
  return {
    pieza: {
      id: randomUUID(),
      red: o.red ?? 'instagram',
      formato: o.formato ?? 'carrusel',
      pilar: o.pilar ?? 'Origen del café',
      trabajo: o.trabajo ?? 'atraer',
      idea: o.idea ?? 'Un vistazo al origen de nuestros granos',
      fechaHora: o.fechaHora ?? PIEZA_INSTANTE,
      hechoIds: o.hechoIds ?? [],
    },
    zonaHoraria: o.zonaHoraria ?? 'America/New_York',
    perfil: {
      identidad: o.identidad ?? structuredClone(SEED_PROFILE.identidad),
      voz: o.voz ?? structuredClone(SEED_PROFILE.voz),
      kit_visual: o.kitVisual ?? structuredClone(SEED_PROFILE.kit_visual),
      idioma_contenido: o.idioma === undefined ? 'es' : o.idioma,
    },
    hechos: o.hechos ?? [HECHO_PRECIO, HECHO_HORARIO, HECHO_PROMO, HECHO_CIFRA],
    reglas: o.reglas ?? REGLAS,
    media: o.media ?? makeLibrary(),
  };
}

export function makeBriefContext(o: BriefSnapshotOverrides = {}): BriefContext {
  return buildBriefContext(makeBriefSnapshot(o));
}

/**
 * A valid brief for the context: right count of scenes for the format, candidate media of the right
 * type where there is any (missing-media slots with a reason otherwise), alt text on image formats,
 * every cited fact used through its token. Texts are neutral: no digits, no banned terms.
 */
export function validBrief(context: BriefContext): BriefContent {
  const limites = context.limites.formato;
  const n = limites.escenasMin;
  const aptos = context.candidatos.filter((m) => limites.tiposMedia.includes(m.tipo));
  const duracion = limites.duracionTotalS ? limites.duracionTotalS.min + 5 : undefined;
  const citados = context.hechos.filter((h) => h.citado);
  const tokens = citados.map((h) => `{{hecho:${h.id}}}`).join(' ');
  const escenas = Array.from({ length: n }, (_v, i) => {
    const media = aptos[i];
    return {
      orden: i + 1,
      texto_en_pantalla: i === 0 && tokens ? `Mira esto ${tokens}` : `Escena ${i === 0 ? 'inicial' : 'siguiente'} del origen`,
      ...(limites.requiereTextoAlternativo ? { texto_alternativo: 'Granos de café sobre una mesa de madera' } : {}),
      ...(duracion ? { duracion_s: duracion / n } : {}),
      toma: media
        ? { media_id: media.id }
        : { media_id: null, motivo_faltante: 'No hay media adecuada para esta escena' },
    };
  });
  return {
    formato: context.pieza.formato,
    gancho: 'El origen de tu café de hoy',
    escenas,
    texto_publicacion: { texto: 'Hecho con calma, como siempre.', hashtags: ['#cafe', '#origen'], ubicacion: 'Nuestro barrio' },
    llamado_a_accion: 'Pásate por tu café de hoy',
    musica: 'Acústica suave',
    portada: 'Primera foto del carrusel',
    notas_produccion: 'Mantener la luz natural y el ritmo pausado',
    hechos_omitidos: [],
  };
}
