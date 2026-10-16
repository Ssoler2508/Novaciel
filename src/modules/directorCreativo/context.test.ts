import { describe, expect, it } from 'vitest';
import { HECHO_PRECIO, HECHO_PROMO, makeBriefContext, makeBriefSnapshot, makeLibrary } from '../../../tests/utils/briefFixtures.js';
import { buildBriefContext } from './context.js';
import { BriefContextError } from './errors.js';
import { LIMITES_FORMATO } from './limits.js';

describe('buildBriefContext', () => {
  it('builds the piece, brand, voice, visual style, facts, rules, candidates and limits', () => {
    const media = makeLibrary();
    const context = makeBriefContext({ hechoIds: [HECHO_PRECIO.id], media });
    expect(context.pieza).toMatchObject({
      red: 'instagram',
      formato: 'carrusel',
      pilar: 'Origen del café',
      trabajo: 'atraer',
      fecha: '2026-11-03',
      hora: '10:00',
      zonaHoraria: 'America/New_York',
    });
    expect(context.marca.nombre).toBe('Cafetería Aurora');
    expect(context.idioma).toBe('es');
    expect(context.voz).toMatchObject({ trato: 'tú', emojis: 'poco', usa_humor: true });
    expect(context.voz.adjetivos).toContain('cercana');
    expect(context.visual).toEqual({
      aparecen_personas: true,
      estilo_imagen: { luminosidad: 'luminoso', temperatura: 'cálido', limpieza: 'limpio', produccion: 'natural' },
    });
    expect(context.hechos.filter((h) => h.citado).map((h) => h.id)).toEqual([HECHO_PRECIO.id]);
    expect(context.hechos).toHaveLength(4);
    expect(context.reglas.length).toBeGreaterThan(0);
    expect(context.candidatos.map((m) => m.id)).toEqual(media.map((m) => m.id));
    expect(context.limites.formato).toBe(LIMITES_FORMATO.carrusel);
  });

  it('reads only the allowed voice and visual keys: logos, colours and fonts stay out', () => {
    const context = makeBriefContext({
      voz: { adjetivos: ['cálida'], secreto: 'no debe pasar' },
      kitVisual: { aparecen_personas: false, logo_claro: 'x.png', colores: { principal: '#000' }, tipografia_titulos: 'Inter', estilo_imagen: { luminosidad: 'luminoso', otro: 'no' } },
    });
    expect(Object.keys(context.voz).sort()).toEqual(['adjetivos', 'adjetivos_nunca', 'emojis', 'frases_propias', 'trato', 'usa_humor']);
    expect(context.visual).toEqual({ aparecen_personas: false, estilo_imagen: { luminosidad: 'luminoso' } });
    expect(JSON.stringify(context)).not.toMatch(/no debe pasar|logo|#000|tipografia/);
  });

  it('shows the local time of the plan zone', () => {
    // 2026-03-09 is after the spring-forward change: 14:00Z is 10:00 in New York (EDT, UTC-4).
    const context = makeBriefContext({ fechaHora: new Date('2026-03-09T14:00:00Z') });
    expect(context.pieza).toMatchObject({ fecha: '2026-03-09', hora: '10:00' });
  });

  it('flags nothing as cited when the piece cites no fact, and keeps unknown cited ids out of the flags', () => {
    expect(makeBriefContext().hechos.some((h) => h.citado)).toBe(false);
    const context = makeBriefContext({ hechoIds: [HECHO_PROMO.id.toUpperCase()] });
    expect(context.hechos.find((h) => h.id === HECHO_PROMO.id)!.citado).toBe(true);
  });

  it('does not share references with the snapshot', () => {
    const snapshot = makeBriefSnapshot();
    const context = buildBriefContext(snapshot);
    expect(context.candidatos[0]).not.toBe(snapshot.media[0]);
    expect(context.hechos[0]).not.toBe(snapshot.hechos[0]);
  });

  it('keeps all three languages, "ambos" included', () => {
    for (const idioma of ['es', 'en', 'ambos'] as const) expect(makeBriefContext({ idioma }).idioma).toBe(idioma);
  });

  it.each([
    ['idioma_contenido', { idioma: null }],
    ['voz', { voz: {} }],
    ['voz', { voz: { adjetivos: 'no es una lista' } }],
    ['kit_visual.aparecen_personas', { kitVisual: { aparecen_personas: 'si' } }],
    ['kit_visual.estilo_imagen', { kitVisual: { estilo_imagen: ['x'] } }],
    ['zona_horaria', { zonaHoraria: 'Mars/Olympus' }],
    ['pieza.fecha_hora', { fechaHora: new Date('invalid') }],
    ['pieza', { idea: '   ' }],
  ] as const)('throws BriefContextError(%s) on bad data', (field, overrides) => {
    try {
      makeBriefContext(overrides as never);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BriefContextError);
      expect((error as BriefContextError).field).toBe(field);
    }
  });

  it('rejects duplicated candidate ids', () => {
    const [m] = makeLibrary();
    expect(() => makeBriefContext({ media: [m!, m!] })).toThrow(expect.objectContaining({ field: 'media' }));
  });
});
