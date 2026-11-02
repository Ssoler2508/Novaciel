import { describe, expect, it } from 'vitest';
import { HECHO_HORARIO, HECHO_PRECIO, makeBriefContext, makeLibrary, makeMedia, validBrief } from '../../../tests/utils/briefFixtures.js';
import { SEED_PROFILE } from '../../scripts/seedProfile.js';
import { buildDeterministicBrief } from './deterministicBriefFake.js';
import { TITULO_RESPALDO_MAX } from './limits.js';
import { BRIEF_SYSTEM, BRIEF_SYSTEM_VOZ, buildBriefPrompt } from './prompt.js';
import { BRIEF_ISSUES, buildBriefSchema } from './schema.js';
import type { BriefContext } from './types.js';

// Debt cleanup 01, checkpoint C: the creative director for a reel WITH a voice-over (`conVoz`). With a voice,
// `voz_en_off` is the main text of every scene and `texto_en_pantalla` a short fallback title (drawn only if the
// voice is omitted at production). Nothing changes for a client without voice or for a format other than reel.

const LOCUCION = { habilitada: true, voice_id: 'VozFicticia1', idioma: 'es' };
const conLocucion = (locucion: unknown) => ({ ...structuredClone(SEED_PROFILE.voz), locucion }) as Record<string, unknown>;
const ctx = (o: Parameters<typeof makeBriefContext>[0] = {}) => makeBriefContext({ formato: 'reel', media: makeLibrary(), ...o });
const conVoz = (o: Parameters<typeof makeBriefContext>[0] = {}) => ctx({ voz: conLocucion(LOCUCION), ...o });

const issuesOf = (context: BriefContext, brief: unknown): string[] => {
  const r = buildBriefSchema(context).safeParse(brief);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
type Mutable = Record<string, any>;

describe('BriefContext.conVoz', () => {
  it('is true for a reel of a client with a voice enabled', () => {
    expect(conVoz().conVoz).toBe(true);
  });

  it.each([
    ['a voice that is not enabled', conLocucion({ ...LOCUCION, habilitada: false })],
    ['no locucion block', structuredClone(SEED_PROFILE.voz) as Record<string, unknown>],
    ['a block that is not valid (production will refuse it loudly)', conLocucion({ habilitada: true, voice_id: 'no valido!', idioma: 'es' })],
  ])('is false for %s', (_name, voz) => {
    expect(ctx({ voz }).conVoz).toBe(false);
  });

  it.each(['carrusel', 'post', 'historia'] as const)('is false for a %s even if the client has a voice enabled', (formato) => {
    expect(makeBriefContext({ formato, voz: conLocucion(LOCUCION) }).conVoz).toBe(false);
  });
});

describe('the prompt for a reel with a voice-over', () => {
  const plain = (c: BriefContext) => buildBriefPrompt({ ...c, conVoz: false });

  it('is exactly the same as before for a client without voice and for formats other than reel', () => {
    for (const c of [ctx(), makeBriefContext({ formato: 'carrusel', voz: conLocucion(LOCUCION) }), makeBriefContext({ formato: 'post', voz: conLocucion(LOCUCION) })]) {
      const p = buildBriefPrompt(c);
      expect(p).toEqual(plain(c));
      expect(p.system).toBe(BRIEF_SYSTEM);
      expect(p.user).not.toMatch(/voice-over: on/);
    }
  });

  it('adds only the fixed voice rules to the system text and one parameter line to the user text', () => {
    const c = conVoz();
    const withVoice = buildBriefPrompt(c);
    expect(withVoice.system).toBe(`${BRIEF_SYSTEM}\n${BRIEF_SYSTEM_VOZ}`);
    const line = `- voice-over: on; the fallback title "texto_en_pantalla" has at most ${TITULO_RESPALDO_MAX} characters`;
    expect(withVoice.user).toContain(line);
    expect(withVoice.user.replace(`${line}\n`, '')).toBe(plain(c).user);
  });

  it('says that voz_en_off is the main text, spoken and subtitled, and that the title is a short fallback', () => {
    expect(BRIEF_SYSTEM_VOZ).toMatch(/"voz_en_off" is the main text of EVERY scene/);
    expect(BRIEF_SYSTEM_VOZ).toMatch(/word-by-word subtitles/);
    expect(BRIEF_SYSTEM_VOZ).toMatch(/fallback title/);
    expect(BRIEF_SYSTEM_VOZ).toMatch(/only if the voice cannot be used/);
  });

  it('never carries the voice configuration of the client', () => {
    const p = buildBriefPrompt(conVoz());
    expect(`${p.system}\n${p.user}`).not.toMatch(/VozFicticia1|voice_id|habilitada|locucion/);
  });
});

describe('the schema for a reel with a voice-over', () => {
  const ok = (c: BriefContext) => validBrief(c) as unknown as Mutable;

  it('accepts a brief with a spoken text and a short title in every scene', () => {
    const c = conVoz({ hechoIds: [HECHO_HORARIO.id] });
    expect(issuesOf(c, ok(c))).toEqual([]);
  });

  it('requires a non-empty voz_en_off in every scene (missing_voice_over)', () => {
    const c = conVoz();
    const missing = ok(c);
    delete missing.escenas[1].voz_en_off;
    expect(issuesOf(c, missing)).toContain(BRIEF_ISSUES.missingVoiceOver);
    const blank = ok(c);
    blank.escenas[0].voz_en_off = '   ';
    expect(issuesOf(c, blank)).toContain(BRIEF_ISSUES.missingVoiceOver);
  });

  it('limits the fallback title (fallback_title_too_long) but keeps it required', () => {
    const c = conVoz();
    const exact = ok(c);
    exact.escenas[0].texto_en_pantalla = 'a'.repeat(TITULO_RESPALDO_MAX);
    expect(issuesOf(c, exact)).toEqual([]);
    const long = ok(c);
    long.escenas[0].texto_en_pantalla = 'a'.repeat(TITULO_RESPALDO_MAX + 1);
    expect(issuesOf(c, long)).toContain(BRIEF_ISSUES.fallbackTitleTooLong);
    for (const empty of ['', '   ']) {
      const none = ok(c);
      none.escenas[0].texto_en_pantalla = empty;
      expect(issuesOf(c, none), JSON.stringify(empty)).not.toEqual([]);
    }
  });

  it('the spoken text keeps its limit and the figures rule', () => {
    const c = conVoz();
    const tooLong = ok(c);
    tooLong.escenas[0].voz_en_off = 'a'.repeat(c.limites.texto.vozEnOff + 1);
    expect(issuesOf(c, tooLong)).toContain(BRIEF_ISSUES.textTooLong);
    const figure = ok(c);
    figure.escenas[0].voz_en_off = 'Abrimos desde las 9';
    expect(issuesOf(c, figure)).toContain(BRIEF_ISSUES.freeTextNumber);
  });

  it('without a voice nothing is new: no voice required, the title keeps its usual limit, empty text still fails', () => {
    const c = ctx();
    const b = ok(c);
    delete b.escenas[0].voz_en_off;
    b.escenas[0].texto_en_pantalla = 'a'.repeat(TITULO_RESPALDO_MAX + 20);
    expect(issuesOf(c, b)).toEqual([]);
    b.escenas[0].texto_en_pantalla = '';
    expect(issuesOf(c, b)).not.toEqual([]);
    expect(issuesOf(c, b)).not.toContain(BRIEF_ISSUES.missingVoiceOver);
  });

  it('other formats with a voice enabled are validated as always', () => {
    const c = makeBriefContext({ formato: 'carrusel', voz: conLocucion(LOCUCION) });
    expect(issuesOf(c, validBrief(c))).toEqual([]);
  });
});

describe('the deterministic fake for a reel with a voice-over', () => {
  const LIBS = [[], [makeMedia({ tipo: 'video' })], makeLibrary()];
  const IDIOMAS = ['es', 'en', 'ambos'] as const;

  it.each(LIBS.flatMap((media) => IDIOMAS.map((idioma) => [media.length, idioma, media] as const)))('(%i media, %s) passes its own schema, with a spoken text and a short title in every scene', (_n, idioma, media) => {
    const c = conVoz({ idioma, media, hechoIds: [HECHO_HORARIO.id, HECHO_PRECIO.id] });
    const brief = buildDeterministicBrief(c);
    expect(issuesOf(c, brief)).toEqual([]);
    for (const e of brief.escenas) {
      expect((e.voz_en_off ?? '').trim()).not.toBe('');
      expect(e.texto_en_pantalla.trim()).not.toBe('');
      expect(e.texto_en_pantalla.length).toBeLessThanOrEqual(TITULO_RESPALDO_MAX);
      expect(e.texto_en_pantalla).not.toContain('{{hecho:');
    }
    // The cited facts are spoken, through their tokens.
    expect(brief.escenas.map((e) => e.voz_en_off).join(' ')).toContain('{{hecho:');
  });

  it('is unchanged without voice and for the other formats (facts stay in the on-screen text)', () => {
    const c = ctx({ hechoIds: [HECHO_HORARIO.id] });
    const brief = buildDeterministicBrief(c);
    expect(issuesOf(c, brief)).toEqual([]);
    expect(brief.escenas.some((e) => e.texto_en_pantalla.includes('{{hecho:'))).toBe(true);
    expect(brief.escenas.every((e) => !(e.voz_en_off ?? '').includes('{{hecho:'))).toBe(true);
    for (const formato of ['carrusel', 'post', 'historia'] as const) {
      const media = makeLibrary();
      const sin = makeBriefContext({ formato, media, hechoIds: [HECHO_HORARIO.id] });
      const con = makeBriefContext({ formato, media, hechoIds: [HECHO_HORARIO.id], voz: conLocucion(LOCUCION) });
      expect(buildDeterministicBrief(con)).toEqual(buildDeterministicBrief(sin));
    }
  });
});
