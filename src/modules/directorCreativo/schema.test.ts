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
  validBrief,
} from '../../../tests/utils/briefFixtures.js';
import { BRIEF_ISSUES, buildBriefSchema, type BriefContent } from './schema.js';
import { factToken } from './tokens.js';
import type { BriefContext } from './types.js';

type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Messages of every issue the schema finds in `brief` (empty = valid). */
function issuesOf(context: BriefContext, brief: unknown): string[] {
  const result = buildBriefSchema(context).safeParse(brief);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

/** A copy of the valid brief for `context` after `change`. */
function variant(context: BriefContext, change: (brief: Mutable) => void): Mutable {
  const brief = structuredClone(validBrief(context)) as Mutable;
  change(brief);
  return brief;
}

/** The change produces this issue code (and the unchanged brief produces none). */
function expectIssue(context: BriefContext, change: (brief: Mutable) => void, code: string) {
  expect(issuesOf(context, validBrief(context))).toEqual([]);
  expect(issuesOf(context, variant(context, change))).toContain(code);
}

const carrusel = () => makeBriefContext({ formato: 'carrusel' });
const reel = () => makeBriefContext({ formato: 'reel' });

describe('a valid brief passes', () => {
  it.each(['reel', 'carrusel', 'post', 'historia'] as const)('format %s', (formato) => {
    const context = makeBriefContext({ formato });
    const brief = validBrief(context);
    expect(issuesOf(context, brief)).toEqual([]);
    const parsed = buildBriefSchema(context).parse(brief);
    expect(parsed.formato).toBe(formato);
    expect(parsed.escenas).toHaveLength(context.limites.formato.escenasMin);
  });

  it('with media for every slot, with missing slots, and with no library at all', () => {
    for (const media of [makeLibrary(), [makeMedia({ tipo: 'foto' })], []]) {
      const context = makeBriefContext({ formato: 'carrusel', media });
      expect(issuesOf(context, validBrief(context))).toEqual([]);
    }
  });

  it('a video slot with in and out marks inside the clip', () => {
    const context = reel();
    const brief = variant(context, (b) => {
      b.escenas[0].toma = { media_id: context.candidatos.find((m) => m.tipo === 'video')!.id, entrada_ms: 1000, salida_ms: 5000 };
    });
    expect(issuesOf(context, brief)).toEqual([]);
  });

  it('keeps the tokens in the parsed content', () => {
    const context = makeBriefContext({ hechoIds: [HECHO_PRECIO.id] });
    const parsed = buildBriefSchema(context).parse(validBrief(context)) as BriefContent;
    expect(JSON.stringify(parsed)).toContain(factToken(HECHO_PRECIO.id));
  });
});

describe('format, scenes and duration', () => {
  it('the format must be the piece format', () => {
    expectIssue(carrusel(), (b) => (b.formato = 'reel'), BRIEF_ISSUES.wrongFormat);
  });

  it.each([
    ['carrusel', 4],
    ['carrusel', 11],
    ['post', 2],
    ['historia', 4],
    ['reel', 2],
    ['reel', 7],
  ] as const)('%s with %i scenes is refused', (formato, count) => {
    const context = makeBriefContext({ formato });
    expectIssue(context, (b) => {
      const base = b.escenas[0];
      b.escenas = Array.from({ length: count }, (_v, i) => ({ ...structuredClone(base), orden: i + 1, toma: { media_id: null, motivo_faltante: 'sin media' } }));
      if (formato === 'reel') b.escenas.forEach((e: Mutable) => (e.duracion_s = 20 / count));
    }, BRIEF_ISSUES.sceneCount);
  });

  it('scene order must be 1..n without gaps', () => {
    expectIssue(carrusel(), (b) => (b.escenas[2].orden = 7), BRIEF_ISSUES.sceneOrder);
  });

  it('a reel scene needs its duration (a number, to check the 15 to 30 s sum)', () => {
    expectIssue(reel(), (b) => delete b.escenas[1].duracion_s, BRIEF_ISSUES.missingSceneDuration);
  });

  it('a reel must add up to 15..30 seconds (both edges allowed)', () => {
    const context = reel();
    const withTotal = (total: number) => variant(context, (b) => b.escenas.forEach((e: Mutable) => (e.duracion_s = total / b.escenas.length)));
    expect(issuesOf(context, withTotal(14.9))).toContain(BRIEF_ISSUES.durationOutOfRange);
    expect(issuesOf(context, withTotal(30.1))).toContain(BRIEF_ISSUES.durationOutOfRange);
    expect(issuesOf(context, withTotal(15))).toEqual([]);
    expect(issuesOf(context, withTotal(30))).toEqual([]);
  });

  it('duration is optional outside reels', () => {
    const context = carrusel();
    expect(issuesOf(context, variant(context, (b) => b.escenas.forEach((e: Mutable) => delete e.duracion_s)))).toEqual([]);
  });
});

describe('media', () => {
  it('rejects an id that is not a candidate, including another client\'s media', () => {
    expectIssue(carrusel(), (b) => (b.escenas[0].toma = { media_id: randomUUID() }), BRIEF_ISSUES.unknownMedia);
    const other = makeMedia({ tipo: 'foto' }); // a real photo, but of another client: not in this context
    expectIssue(carrusel(), (b) => (b.escenas[0].toma = { media_id: other.id }), BRIEF_ISSUES.unknownMedia);
  });

  it('rejects a repeated media id', () => {
    const context = carrusel();
    expectIssue(context, (b) => (b.escenas[1].toma = { media_id: b.escenas[0].toma.media_id }), BRIEF_ISSUES.duplicateMedia);
  });

  it('rejects a media type that does not fit the slot', () => {
    // A candidate list can hold a type the format does not accept (e.g. a video for a carousel).
    const video = makeMedia({ tipo: 'video' });
    const context = makeBriefContext({ formato: 'carrusel', media: [...makeLibrary().filter((m) => m.tipo === 'foto'), video] });
    expectIssue(context, (b) => (b.escenas[0].toma = { media_id: video.id }), BRIEF_ISSUES.mediaTypeMismatch);
    const photo = makeMedia({ tipo: 'foto' });
    const reelContext = makeBriefContext({ formato: 'reel', media: [photo, ...makeLibrary().filter((m) => m.tipo === 'video')] });
    expectIssue(reelContext, (b) => (b.escenas[0].toma = { media_id: photo.id }), BRIEF_ISSUES.mediaTypeMismatch);
  });

  it('a story may use a photo or a video', () => {
    const context = makeBriefContext({ formato: 'historia' });
    const photo = context.candidatos.find((m) => m.tipo === 'foto')!;
    const video = context.candidatos.find((m) => m.tipo === 'video')!;
    for (const media of [photo, video]) {
      expect(issuesOf(context, variant(context, (b) => (b.escenas[0].toma = { media_id: media.id })))).toEqual([]);
    }
  });

  it('marks: only on videos, both or neither, out after in, inside the clip', () => {
    const context = reel();
    const video = context.candidatos.find((m) => m.tipo === 'video')!; // 20 s
    const marks = (toma: Mutable) => (b: Mutable) => (b.escenas[0].toma = { media_id: video.id, ...toma });
    expectIssue(context, marks({ entrada_ms: 1000 }), BRIEF_ISSUES.invalidMarks);
    expectIssue(context, marks({ salida_ms: 1000 }), BRIEF_ISSUES.invalidMarks);
    expectIssue(context, marks({ entrada_ms: 5000, salida_ms: 5000 }), BRIEF_ISSUES.invalidMarks);
    expectIssue(context, marks({ entrada_ms: 5000, salida_ms: 4000 }), BRIEF_ISSUES.invalidMarks);
    expectIssue(context, marks({ entrada_ms: 0, salida_ms: 20_001 }), BRIEF_ISSUES.invalidMarks);
    expect(issuesOf(context, variant(context, marks({ entrada_ms: 0, salida_ms: 20_000 })))).toEqual([]);

    const carruselContext = carrusel();
    expectIssue(carruselContext, (b) => (b.escenas[0].toma = { media_id: b.escenas[0].toma.media_id, entrada_ms: 0, salida_ms: 100 }), BRIEF_ISSUES.marksOnPhoto);
    expectIssue(context, (b) => (b.escenas[2].toma = { media_id: null, motivo_faltante: 'sin media', entrada_ms: 0, salida_ms: 100 }), BRIEF_ISSUES.marksOnPhoto);
  });

  it('a slot without media needs a reason, and a slot with media must not have one', () => {
    const context = carrusel();
    expectIssue(context, (b) => (b.escenas[0].toma = { media_id: null }), BRIEF_ISSUES.missingReasonRequired);
    expectIssue(context, (b) => (b.escenas[0].toma.motivo_faltante = 'sobra'), BRIEF_ISSUES.unexpectedReason);
  });

  it('knows no other source: unknown keys are rejected', () => {
    const context = carrusel();
    for (const change of [
      (b: Mutable) => (b.escenas[0].toma.fuente = 'generacion_ia'),
      (b: Mutable) => (b.escenas[0].generar_con_ia = true),
      (b: Mutable) => (b.extra = 'x'),
      (b: Mutable) => (b.texto_publicacion.otro = 'x'),
    ]) {
      expect(issuesOf(context, variant(context, change)).length).toBeGreaterThan(0);
    }
  });
});

describe('fact tokens', () => {
  const withFacts = (hechoIds: string[] = []) => makeBriefContext({ formato: 'carrusel', hechoIds });

  it('a token naming an unknown fact is rejected', () => {
    expectIssue(withFacts(), (b) => (b.gancho = `Hoy ${factToken(randomUUID())}`), BRIEF_ISSUES.unknownFact);
  });

  it('a fact that is not valid when the piece goes out is rejected', () => {
    const context = makeBriefContext({
      fechaHora: new Date('2026-11-04T10:00:00Z'), // after the promotion ended (Wednesday 05:00 UTC)
    });
    expectIssue(context, (b) => (b.gancho = `Hoy ${factToken(HECHO_PROMO.id)}`), BRIEF_ISSUES.factNotValidAtTime);
    const early = makeBriefContext({ fechaHora: new Date('2026-09-30T10:00:00Z') });
    expectIssue(early, (b) => (b.gancho = `Hoy ${factToken(HECHO_PRECIO.id)}`), BRIEF_ISSUES.factNotValidAtTime);
  });

  it('malformed tokens are rejected', () => {
    for (const bad of ['{{hecho:abc}}', '{{precio}}', `{{hecho:${HECHO_PRECIO.id}`, '}} suelto']) {
      expectIssue(withFacts(), (b) => (b.gancho = `Hoy ${bad}`), BRIEF_ISSUES.malformedToken);
    }
  });

  it('a token is not allowed in a hashtag', () => {
    expectIssue(withFacts(), (b) => b.texto_publicacion.hashtags.push(`#${factToken(HECHO_CIFRA.id)}`), BRIEF_ISSUES.tokenNotAllowed);
  });

  it('every cited fact is used through its token or listed as omitted with a reason', () => {
    const context = withFacts([HECHO_PRECIO.id, HECHO_CIFRA.id]);
    const base = validBrief(context);
    expect(issuesOf(context, base)).toEqual([]); // the valid brief uses both tokens

    expectIssue(context, (b) => (b.escenas[0].texto_en_pantalla = 'Sin hechos'), BRIEF_ISSUES.citedFactUnused);
    const omitted = variant(context, (b) => {
      b.escenas[0].texto_en_pantalla = `Mira ${factToken(HECHO_PRECIO.id)}`;
      b.hechos_omitidos = [{ hecho_id: HECHO_CIFRA.id, motivo: 'No cabe en esta pieza' }];
    });
    expect(issuesOf(context, omitted)).toEqual([]);
  });

  it('omitted facts must be cited ones, not used, and not repeated', () => {
    const context = withFacts([HECHO_PRECIO.id]);
    expectIssue(context, (b) => (b.hechos_omitidos = [{ hecho_id: HECHO_CIFRA.id, motivo: 'no era citado' }]), BRIEF_ISSUES.omittedNotCited);
    expectIssue(context, (b) => (b.hechos_omitidos = [{ hecho_id: HECHO_PRECIO.id, motivo: 'pero se usa' }]), BRIEF_ISSUES.omittedButUsed);
    const noToken = variant(context, (b) => {
      b.escenas[0].texto_en_pantalla = 'Sin hechos';
      b.hechos_omitidos = [
        { hecho_id: HECHO_PRECIO.id, motivo: 'uno' },
        { hecho_id: HECHO_PRECIO.id, motivo: 'dos' },
      ];
    });
    expect(issuesOf(context, noToken)).toContain(BRIEF_ISSUES.duplicateOmitted);
  });

  it('a token of a fact not cited by the piece is fine when the fact is valid', () => {
    const context = withFacts();
    expect(issuesOf(context, variant(context, (b) => (b.texto_publicacion.texto = `Hecho con calma ${factToken(HECHO_CIFRA.id)}`)))).toEqual([]);
  });
});

describe('rule 2: no number, price, time or percentage outside a token', () => {
  const context = () => makeBriefContext({ formato: 'carrusel' });

  it('a price typed as free text is rejected, while the same price through a token passes', () => {
    const ctx = makeBriefContext({ hechoIds: [HECHO_PRECIO.id] });
    const asText = variant(ctx, (b) => (b.escenas[0].texto_en_pantalla = 'El café cuesta $6.000 COP'));
    expect(issuesOf(ctx, asText)).toContain(BRIEF_ISSUES.freeTextNumber);
    const asToken = variant(ctx, (b) => (b.escenas[0].texto_en_pantalla = `El café: ${factToken(HECHO_PRECIO.id)}`));
    expect(issuesOf(ctx, asToken)).toEqual([]);
  });

  it.each([
    ['gancho', (b: Mutable) => (b.gancho = 'Solo 3 dias')],
    ['on-screen text', (b: Mutable) => (b.escenas[0].texto_en_pantalla = 'Desde las 8')],
    ['alt text', (b: Mutable) => (b.escenas[0].texto_alternativo = 'Una taza de 250 ml')],
    ['voice-over', (b: Mutable) => (b.escenas[0].voz_en_off = 'Descuento del veinte por ciento')],
    ['caption', (b: Mutable) => (b.texto_publicacion.texto = 'Llevamos ocho años')],
    ['location', (b: Mutable) => (b.texto_publicacion.ubicacion = 'Calle 10 # 5-20')],
    ['hashtag', (b: Mutable) => b.texto_publicacion.hashtags.push('#promo2026')],
    ['call to action', (b: Mutable) => (b.llamado_a_accion = 'Llama al 555 1234')],
    ['production notes', (b: Mutable) => (b.notas_produccion = 'Grabar 10 segundos')],
    ['missing reason', (b: Mutable) => (b.escenas[0].toma = { media_id: null, motivo_faltante: 'Hace falta una foto de 2 mesas' })],
  ])('digits in %s', (_name, change) => {
    expectIssue(context(), change, BRIEF_ISSUES.freeTextNumber);
  });

  it.each([
    ['currency symbol', '€ para ti'],
    ['percentage', 'Gran descuento por ciento'],
    ['time of day', 'Nos vemos a mediodía'],
    ['spelled-out price', 'Solo cinco dólares'],
    ['spelled-out time', 'Abrimos a las ocho pm'],
  ])('%s', (_name, wording) => {
    expectIssue(context(), (b) => (b.gancho = wording), BRIEF_ISSUES.freeTextNumber);
  });

  it('structured numbers (order, duration, marks) are not scanned', () => {
    const ctx = reel();
    expect(issuesOf(ctx, validBrief(ctx))).toEqual([]);
  });

  it.each([
    ['price', 'El precio de siempre', BRIEF_ISSUES.missingFactForPrice, HECHO_PRECIO],
    ['schedule', 'Abrimos temprano', BRIEF_ISSUES.missingFactForSchedule, HECHO_HORARIO],
    ['promotion', 'Una promo para ti', BRIEF_ISSUES.missingFactForPromotion, HECHO_PROMO],
  ])('talking about a %s needs a token of that type', (_name, wording, code, hecho) => {
    const ctx = makeBriefContext();
    expectIssue(ctx, (b) => (b.texto_publicacion.texto = wording), code);
    const withToken = variant(ctx, (b) => (b.texto_publicacion.texto = `${wording} ${factToken(hecho.id)}`));
    expect(issuesOf(ctx, withToken)).toEqual([]);
    // A token of another type does not count.
    const wrongType = variant(ctx, (b) => (b.texto_publicacion.texto = `${wording} ${factToken(HECHO_CIFRA.id)}`));
    expect(issuesOf(ctx, wrongType)).toContain(code);
  });
});

describe('limits and alt text', () => {
  it('rejects text over each house cap', () => {
    const ctx = carrusel();
    const long = (n: number) => 'a'.repeat(n);
    const t = ctx.limites.texto;
    for (const change of [
      (b: Mutable) => (b.gancho = long(t.gancho + 1)),
      (b: Mutable) => (b.escenas[0].texto_en_pantalla = long(t.textoEnPantalla + 1)),
      (b: Mutable) => (b.escenas[0].texto_alternativo = long(t.textoAlternativo + 1)),
      (b: Mutable) => (b.escenas[0].voz_en_off = long(t.vozEnOff + 1)),
      (b: Mutable) => (b.texto_publicacion.texto = long(t.textoPublicacion + 1)),
      (b: Mutable) => (b.texto_publicacion.ubicacion = long(t.ubicacion + 1)),
      (b: Mutable) => (b.llamado_a_accion = long(t.llamadoAccion + 1)),
      (b: Mutable) => (b.musica = long(t.musica + 1)),
      (b: Mutable) => (b.portada = long(t.portada + 1)),
      (b: Mutable) => (b.notas_produccion = long(t.notasProduccion + 1)),
      (b: Mutable) => (b.escenas[0].toma = { media_id: null, motivo_faltante: long(t.motivo + 1) }),
    ]) {
      expectIssue(ctx, change, BRIEF_ISSUES.textTooLong);
    }
  });

  it('accepts text exactly at the cap', () => {
    const ctx = carrusel();
    expect(issuesOf(ctx, variant(ctx, (b) => (b.texto_publicacion.texto = 'a'.repeat(ctx.limites.texto.textoPublicacion))))).toEqual([]);
  });

  it('limits hashtags in number and shape', () => {
    const ctx = carrusel();
    expectIssue(ctx, (b) => (b.texto_publicacion.hashtags = Array.from({ length: ctx.limites.hashtagsMax + 1 }, (_v, i) => `#tag${'x'.repeat(i + 1)}`)), BRIEF_ISSUES.tooManyHashtags);
    for (const bad of ['sin-numeral', '#con espacio', '#', '#con-guion', '##doble']) {
      expectIssue(ctx, (b) => b.texto_publicacion.hashtags.push(bad), BRIEF_ISSUES.invalidHashtag);
    }
    expect(issuesOf(ctx, variant(ctx, (b) => (b.texto_publicacion.hashtags = ['#café', '#origen_colombiano'])))).toEqual([]);
  });

  it.each(['carrusel', 'post', 'historia'] as const)('every %s slide needs alt text, missing-media slots included', (formato) => {
    const ctx = makeBriefContext({ formato, media: [] });
    expectIssue(ctx, (b) => delete b.escenas[0].texto_alternativo, BRIEF_ISSUES.missingAltText);
  });

  it('a reel needs no alt text', () => {
    const ctx = reel();
    expect(issuesOf(ctx, variant(ctx, (b) => b.escenas.forEach((e: Mutable) => delete e.texto_alternativo)))).toEqual([]);
  });

  it('every required text must be non-empty', () => {
    const ctx = carrusel();
    for (const change of [
      (b: Mutable) => (b.gancho = '  '),
      (b: Mutable) => (b.escenas[0].texto_en_pantalla = ''),
      (b: Mutable) => (b.texto_publicacion.texto = ''),
      (b: Mutable) => (b.llamado_a_accion = ''),
      (b: Mutable) => (b.notas_produccion = ''),
    ]) {
      expect(issuesOf(ctx, variant(ctx, change)).length).toBeGreaterThan(0);
    }
  });
});

describe('banned terms', () => {
  const ctx = () => makeBriefContext({ formato: 'carrusel' }); // rules: garantizado, "El mejor café de la ciudad", Política

  it.each([
    ['a banned word (whole word, accents and case ignored)', 'Resultado GARANTIZADO'],
    ['a banned promise', 'Somos el MEJOR cafe de la ciudad, ¿o no?'],
    ['a banned topic', 'Hablemos de política hoy'],
  ])('rejects %s', (_name, wording) => {
    for (const field of [
      (b: Mutable, w: string) => (b.gancho = w),
      (b: Mutable, w: string) => (b.escenas[0].texto_alternativo = w),
      (b: Mutable, w: string) => (b.escenas[0].voz_en_off = w),
      (b: Mutable, w: string) => (b.texto_publicacion.texto = w),
      (b: Mutable, w: string) => (b.notas_produccion = w),
    ]) {
      expectIssue(ctx(), (b) => field(b, wording), BRIEF_ISSUES.bannedTerm);
    }
  });

  it('a banned WORD only counts as a whole word', () => {
    const c = ctx();
    expect(issuesOf(c, variant(c, (b) => (b.gancho = 'Un café no garantizadora')))).toEqual([]);
  });

  it('checks the text after rendering the tokens', () => {
    const banned = { ...HECHO_CIFRA, id: randomUUID(), enunciado: 'Nuestro café está garantizado por años.' };
    const c = makeBriefContext({ hechos: [banned] });
    expectIssue(c, (b) => (b.gancho = `Mira ${factToken(banned.id)}`), BRIEF_ISSUES.bannedTerm);
  });

  it('ignores elemento_visual rules in the copy (they apply to the media candidates)', () => {
    const c = ctx();
    expect(issuesOf(c, variant(c, (b) => (b.gancho = 'Fondos oscuros no, luz natural sí')))).toEqual([]);
  });
});

describe('no AI-generated client assets', () => {
  const ctx = () => makeBriefContext({ formato: 'carrusel' });

  it.each([
    'Genera una imagen del plato',
    'generate a photo of the shop',
    'usa Midjourney para el local',
    'DALL-E para el fondo',
    'Stable Diffusion',
    'una toma de Sora',
    'stock photo de una cafetería',
    'banco de imágenes',
    'AI-generated barista',
    'barista generado con IA',
  ])('a request such as "%s" is invalid in any text field', (wording) => {
    for (const field of [
      (b: Mutable) => (b.gancho = wording),
      (b: Mutable) => (b.texto_publicacion.texto = wording),
      (b: Mutable) => (b.notas_produccion = wording),
      (b: Mutable) => (b.escenas[0].toma = { media_id: null, motivo_faltante: wording }),
    ]) {
      expectIssue(ctx(), field, BRIEF_ISSUES.aiGenerationRequest);
    }
  });

  it('a plain mention of AI is fine in the copy but invalid in production fields', () => {
    const c = ctx();
    const mention = 'Nuestro negocio trabaja con inteligencia artificial';
    for (const copy of [
      (b: Mutable) => (b.gancho = mention),
      (b: Mutable) => (b.escenas[0].texto_en_pantalla = mention),
      (b: Mutable) => (b.escenas[0].texto_alternativo = mention),
      (b: Mutable) => (b.escenas[0].voz_en_off = mention),
      (b: Mutable) => (b.texto_publicacion.texto = mention),
      (b: Mutable) => (b.llamado_a_accion = mention),
    ]) {
      expect(issuesOf(c, variant(c, copy))).toEqual([]);
    }
    for (const production of [
      (b: Mutable) => (b.notas_produccion = 'Usar IA para el fondo'),
      (b: Mutable) => (b.escenas[0].toma = { media_id: null, motivo_faltante: 'La IA lo resuelve' }),
      (b: Mutable) => (b.portada = 'Portada hecha con AI'),
      (b: Mutable) => (b.musica = 'Música de inteligencia artificial'),
    ]) {
      expectIssue(c, production, BRIEF_ISSUES.aiMentionInProduction);
    }
  });
});

describe('structure', () => {
  it('rejects output that is not an object of the right shape', () => {
    const ctx = carrusel();
    for (const bad of [null, 'texto', [], {}, { ...validBrief(ctx), escenas: [] }, { ...validBrief(ctx), formato: 'documental' }]) {
      expect(issuesOf(ctx, bad).length).toBeGreaterThan(0);
    }
  });

  it('requires uuids for media and fact ids', () => {
    const ctx = carrusel();
    expect(issuesOf(ctx, variant(ctx, (b) => (b.escenas[0].toma = { media_id: 'not-a-uuid' }))).length).toBeGreaterThan(0);
    expect(issuesOf(ctx, variant(ctx, (b) => (b.hechos_omitidos = [{ hecho_id: 'x', motivo: 'y' }]))).length).toBeGreaterThan(0);
  });

  it('issue messages are stable codes: never the content of the brief', () => {
    const ctx = makeBriefContext({ hechoIds: [HECHO_PRECIO.id] });
    const brief = variant(ctx, (b) => {
      b.gancho = 'SECRETO-DE-PRUEBA cuesta $99 garantizado';
      b.escenas[0].toma = { media_id: randomUUID() };
    });
    const messages = issuesOf(ctx, brief);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message).toMatch(/^[a-z_]+$|^Invalid|^Expected|^Too|^Unrecognized|^Required/);
    expect(messages.join(' ')).not.toContain('SECRETO-DE-PRUEBA');
  });
});
