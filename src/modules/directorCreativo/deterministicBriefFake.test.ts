import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HECHO_CIFRA,
  HECHO_HORARIO,
  HECHO_PRECIO,
  HECHO_PROMO,
  makeBriefContext,
  makeLibrary,
  makeMedia,
  PIEZA_INSTANTE,
  REGLAS,
} from '../../../tests/utils/briefFixtures.js';
import type { HechoPlanner } from '../planificador/types.js';
import { mentionsPrice, mentionsPromotion, mentionsSchedule } from '../planificador/textMatch.js';
import { mentionsAi, mentionsAiGenerationRequest, mentionsNumber } from './detectors.js';
import { buildDeterministicBrief } from './deterministicBriefFake.js';
import { buildBriefSchema } from './schema.js';
import { extractFactTokenIds, forEachString, renderFactTokens } from './tokens.js';
import type { BriefContext, MediaCandidate } from './types.js';

const FORMATOS = ['reel', 'carrusel', 'post', 'historia'] as const;
const IDIOMAS = ['es', 'en', 'ambos'] as const;
const photos = (n: number) => Array.from({ length: n }, (_v, i) => makeMedia({ n: i, tipo: 'foto' }));
const videos = (n: number) => Array.from({ length: n }, (_v, i) => makeMedia({ n: 20 + i, tipo: 'video' }));
const LIBRARIES: [string, MediaCandidate[]][] = [
  ['no media', []],
  ['photos only', photos(6)],
  ['videos only', videos(2)],
  ['mixed', makeLibrary()],
  ['fewer media than slots', photos(2)],
];

/** A fact that is valid now but ended before the piece goes out. */
const HECHO_VENCIDO: HechoPlanner = {
  id: randomUUID(),
  tipo: 'promocion',
  enunciado: 'Un especial que ya terminó.',
  vigente_desde: new Date('2026-10-01T00:00:00Z'),
  vigente_hasta: new Date('2026-11-03T14:00:00Z'),
};
/** A fact whose own text hits a banned rule once rendered. */
const HECHO_PROHIBIDO: HechoPlanner = {
  id: randomUUID(),
  tipo: 'otro',
  enunciado: 'Resultado garantizado en todo.',
  vigente_desde: new Date('2026-10-01T00:00:00Z'),
  vigente_hasta: null,
};
const ALL_FACTS = [HECHO_PRECIO, HECHO_HORARIO, HECHO_PROMO, HECHO_CIFRA, HECHO_VENCIDO, HECHO_PROHIBIDO];

const valid = (context: BriefContext) => buildBriefSchema(context).safeParse(buildDeterministicBrief(context));

describe('DeterministicBriefFake: always a valid brief', () => {
  const cases = FORMATOS.flatMap((formato) => IDIOMAS.flatMap((idioma) => LIBRARIES.map(([name, media]) => [formato, idioma, name, media] as const)));
  it.each(cases)('%s, %s, %s', (formato, idioma, _name, media) => {
    const context = makeBriefContext({ formato, idioma, media });
    const result = valid(context);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues.map((i) => i.message))).toBe(true);
  });

  it.each([
    ['no cited fact', []],
    ['one cited fact', [HECHO_PRECIO.id]],
    ['three cited facts', [HECHO_PRECIO.id, HECHO_HORARIO.id, HECHO_CIFRA.id]],
    ['five cited facts', [HECHO_PRECIO.id, HECHO_HORARIO.id, HECHO_CIFRA.id, HECHO_PROMO.id, HECHO_VENCIDO.id]],
    ['an expired and a banned fact', [HECHO_VENCIDO.id, HECHO_PROHIBIDO.id, HECHO_PRECIO.id]],
  ])('%s, in every format', (_name, hechoIds) => {
    for (const formato of FORMATOS) {
      const context = makeBriefContext({ formato, hechoIds, hechos: ALL_FACTS, media: makeLibrary() });
      const result = valid(context);
      expect(result.success, `${formato}: ${result.success ? '' : JSON.stringify(result.error.issues.map((i) => i.message))}`).toBe(true);
    }
  });

  it('is deterministic: the same context gives the same brief', () => {
    const media = makeLibrary();
    const make = () => makeBriefContext({ formato: 'carrusel', hechoIds: [HECHO_PRECIO.id], media });
    expect(buildDeterministicBrief(make())).toEqual(buildDeterministicBrief(make()));
  });
});

describe('DeterministicBriefFake: media', () => {
  it('uses the candidate media in order when there is some', () => {
    const media = photos(6);
    const brief = buildDeterministicBrief(makeBriefContext({ formato: 'carrusel', media }));
    expect(brief.escenas.map((e) => e.toma.media_id)).toEqual(media.slice(0, 5).map((m) => m.id));
  });

  it('marks the slots without media as missing, with a reason', () => {
    const none = buildDeterministicBrief(makeBriefContext({ formato: 'carrusel', media: [] }));
    expect(none.escenas.every((e) => e.toma.media_id === null && (e.toma.motivo_faltante ?? '') !== '')).toBe(true);
    const few = buildDeterministicBrief(makeBriefContext({ formato: 'carrusel', media: photos(2) }));
    expect(few.escenas.map((e) => e.toma.media_id !== null)).toEqual([true, true, false, false, false]);
  });

  it('only uses the media types the format accepts', () => {
    const library = makeLibrary(); // six photos, two videos
    const reel = buildDeterministicBrief(makeBriefContext({ formato: 'reel', media: library }));
    const videoIds = new Set(library.filter((m) => m.tipo === 'video').map((m) => m.id));
    for (const e of reel.escenas) if (e.toma.media_id) expect(videoIds.has(e.toma.media_id)).toBe(true);
    const carousel = buildDeterministicBrief(makeBriefContext({ formato: 'carrusel', media: library }));
    for (const e of carousel.escenas) if (e.toma.media_id) expect(videoIds.has(e.toma.media_id)).toBe(false);
  });

  it('gives a video slot in and out marks inside the clip, and a reel a total of 20 seconds', () => {
    const clip = makeMedia({ tipo: 'video', duracion_ms: 2000 });
    const reel = buildDeterministicBrief(makeBriefContext({ formato: 'reel', media: [clip, ...videos(1)] }));
    expect(reel.escenas[0]!.toma).toMatchObject({ media_id: clip.id, entrada_ms: 0, salida_ms: 2000 });
    expect(reel.escenas.reduce((sum, e) => sum + (e.duracion_s ?? 0), 0)).toBeCloseTo(20);
    // A video of unknown length gets no marks.
    const unknown = makeMedia({ tipo: 'video', duracion_ms: null });
    const noMarks = buildDeterministicBrief(makeBriefContext({ formato: 'reel', media: [unknown] }));
    expect(noMarks.escenas[0]!.toma).toEqual({ media_id: unknown.id });
  });

  it('gives every slide of an image format alt text', () => {
    for (const formato of ['carrusel', 'post', 'historia'] as const) {
      const brief = buildDeterministicBrief(makeBriefContext({ formato, media: [] }));
      expect(brief.escenas.every((e) => (e.texto_alternativo ?? '') !== '')).toBe(true);
    }
  });
});

describe('DeterministicBriefFake: facts', () => {
  it('cites the piece facts through tokens that render without leftovers', () => {
    const context = makeBriefContext({ formato: 'carrusel', hechoIds: [HECHO_PRECIO.id, HECHO_HORARIO.id, HECHO_CIFRA.id], hechos: ALL_FACTS });
    const brief = buildDeterministicBrief(context);
    expect(extractFactTokenIds(brief).sort()).toEqual([HECHO_PRECIO.id, HECHO_HORARIO.id, HECHO_CIFRA.id].sort());
    expect(brief.hechos_omitidos).toEqual([]);
    const rendered = renderFactTokens(brief, context.hechos, PIEZA_INSTANTE);
    expect(JSON.stringify(rendered)).not.toContain('{{hecho:');
    expect(JSON.stringify(rendered)).toContain(HECHO_PRECIO.enunciado);
  });

  it('puts the facts that do not fit a scene in the caption', () => {
    const context = makeBriefContext({ formato: 'post', hechoIds: [HECHO_PRECIO.id, HECHO_HORARIO.id, HECHO_CIFRA.id], hechos: ALL_FACTS });
    const brief = buildDeterministicBrief(context);
    expect(brief.escenas).toHaveLength(1);
    expect(brief.texto_publicacion.texto).toContain(HECHO_HORARIO.id);
    expect(brief.texto_publicacion.texto).toContain(HECHO_CIFRA.id);
    expect(extractFactTokenIds(brief)).toHaveLength(3);
  });

  it('omits, with a reason, a cited fact that ended before the piece or would hit a banned rule', () => {
    const context = makeBriefContext({ formato: 'carrusel', hechoIds: [HECHO_VENCIDO.id, HECHO_PROHIBIDO.id, HECHO_PRECIO.id], hechos: ALL_FACTS });
    const brief = buildDeterministicBrief(context);
    expect(extractFactTokenIds(brief)).toEqual([HECHO_PRECIO.id]);
    expect(brief.hechos_omitidos.map((o) => o.hecho_id).sort()).toEqual([HECHO_VENCIDO.id, HECHO_PROHIBIDO.id].sort());
    expect(brief.hechos_omitidos.every((o) => o.motivo.length > 0)).toBe(true);
  });

  it('does not cite facts the piece does not cite', () => {
    const brief = buildDeterministicBrief(makeBriefContext({ formato: 'carrusel', hechos: ALL_FACTS }));
    expect(extractFactTokenIds(brief)).toEqual([]);
  });
});

describe('DeterministicBriefFake: language and banned rules', () => {
  it('writes in the content language; "ambos" gives the caption in Spanish and then in English', () => {
    const es = buildDeterministicBrief(makeBriefContext({ idioma: 'es' }));
    const en = buildDeterministicBrief(makeBriefContext({ idioma: 'en' }));
    const ambos = buildDeterministicBrief(makeBriefContext({ idioma: 'ambos' }));
    expect(es.texto_publicacion.texto).toContain('Hecho con calma');
    expect(en.texto_publicacion.texto).toContain('Made with calm');
    expect(ambos.texto_publicacion.texto).toContain('Hecho con calma');
    expect(ambos.texto_publicacion.texto).toContain('Made with calm');
    expect(en.gancho).not.toBe(es.gancho);
  });

  it('skips phrases that hit a banned rule and still validates', () => {
    const reglas = [...REGLAS, { tipo: 'palabra' as const, texto: 'calma' }, { tipo: 'tema' as const, texto: 'cerca' }];
    const context = makeBriefContext({ reglas });
    const brief = buildDeterministicBrief(context);
    expect(JSON.stringify(brief).toLowerCase()).not.toMatch(/\bcalma\b|cerca/);
    expect(valid(context).success).toBe(true);
  });

  it('fails loudly, instead of handing on a bad brief, when every phrase is banned', () => {
    const context = makeBriefContext({ reglas: [{ tipo: 'tema', texto: 'a' }] });
    expect(() => buildDeterministicBrief(context)).toThrow(/no phrase that avoids the banned rules/);
  });

  it('never writes digits, price words or mentions of AI in any text', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const idioma of IDIOMAS) {
      for (const formato of FORMATOS) {
        const texts: string[] = [];
        forEachString(buildDeterministicBrief(makeBriefContext({ idioma, formato, media: makeLibrary() })), (t) => {
          if (!uuid.test(t)) texts.push(t);
        });
        expect(texts.length).toBeGreaterThan(5);
        for (const text of texts) {
          expect(mentionsNumber(text), text).toBe(false);
          expect(mentionsAi(text), text).toBe(false);
          expect(mentionsAiGenerationRequest(text), text).toBe(false);
          expect(mentionsPrice(text) || mentionsSchedule(text) || mentionsPromotion(text), text).toBe(false);
        }
      }
    }
  });
});


describe('DeterministicBriefFake: facts the slide font cannot draw', () => {
  const HECHO_EMOJI: HechoPlanner = {
    id: randomUUID(),
    tipo: 'otro',
    enunciado: 'El mejor momento del día ☕ es con nosotros.',
    vigente_desde: new Date('2026-10-01T00:00:00Z'),
    vigente_hasta: null,
  };

  it('omits, with a reason, a cited fact with an emoji instead of putting it on a slide, and still passes its own schema', () => {
    for (const formato of FORMATOS) {
      const context = makeBriefContext({ formato, hechoIds: [HECHO_EMOJI.id, HECHO_PRECIO.id], hechos: [HECHO_EMOJI, HECHO_PRECIO] });
      const brief = buildDeterministicBrief(context);
      expect(extractFactTokenIds(brief)).toEqual([HECHO_PRECIO.id]);
      expect(brief.hechos_omitidos.map((o) => o.hecho_id)).toEqual([HECHO_EMOJI.id]);
      expect(valid(context).success, formato).toBe(true);
    }
  });
});
