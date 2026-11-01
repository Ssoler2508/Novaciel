import { describe, expect, it } from 'vitest';
import { checksReglas } from './reglas.js';
import type { CampoPublicado } from './tipos.js';

const campo = (campo: CampoPublicado['campo'], indice: number, texto: string): CampoPublicado => ({ campo, indice, texto });
const fallos = (campos: CampoPublicado[], reglas: Parameters<typeof checksReglas>[1]) =>
  checksReglas(campos, reglas).flatMap((c) => (c.resultado === 'no_pasa' ? [[c.codigo, c.parametros.campos]] : []));

describe('checksReglas', () => {
  it('returns the three rule codes, all passing when there are no rules or no match', () => {
    expect(checksReglas([campo('texto_publicacion', 0, 'Hola')], []).map((c) => [c.codigo, c.resultado])).toEqual([
      ['regla_prohibida_palabra', 'pasa'],
      ['regla_prohibida_promesa', 'pasa'],
      ['regla_prohibida_tema', 'pasa'],
    ]);
    expect(fallos([campo('texto_publicacion', 0, 'Hola')], [{ tipo: 'palabra', texto: 'gratis' }])).toEqual([]);
  });

  it.each(['café', 'CAFÉ', 'Cafe', 'cAfÉ', 'CAFE'])('a banned word matches the variant "%s" of a text, ignoring accents and case', (variante) => {
    const reglas = [{ tipo: 'palabra', texto: 'cafe' }] as const;
    expect(fallos([campo('texto_publicacion', 0, `Probá nuestro ${variante} de la casa`)], reglas)).toEqual([['regla_prohibida_palabra', ['texto_publicacion:0']]]);
    // And the other way round: the rule written with accent and capitals.
    expect(fallos([campo('texto_publicacion', 0, 'Probá nuestro cafe de la casa')], [{ tipo: 'palabra', texto: 'CAFÉ' }])).toHaveLength(1);
  });

  it('a banned word is a WHOLE word, but a promise or a topic matches anywhere', () => {
    const texto = [campo('texto_publicacion', 0, 'Visita la cafetería')];
    expect(fallos(texto, [{ tipo: 'palabra', texto: 'cafe' }])).toEqual([]);
    expect(fallos(texto, [{ tipo: 'tema', texto: 'cafe' }])).toEqual([['regla_prohibida_tema', ['texto_publicacion:0']]]);
    expect(fallos(texto, [{ tipo: 'promesa', texto: 'CAFETERÍA' }])).toEqual([['regla_prohibida_promesa', ['texto_publicacion:0']]]);
    expect(fallos([campo('hashtag', 0, '#cafe')], [{ tipo: 'palabra', texto: 'cafe' }])).toHaveLength(1);
  });

  it('looks at EVERY published text: caption, hashtags, alt texts, location and on-screen text', () => {
    const reglas = [{ tipo: 'palabra', texto: 'gratis' }] as const;
    for (const kind of ['texto_publicacion', 'hashtag', 'texto_alternativo', 'texto_en_pantalla', 'ubicacion'] as const) {
      expect(fallos([campo('texto_publicacion', 0, 'Hola'), campo(kind, 3, 'Todo GRATIS hoy')], reglas), kind).toEqual([['regla_prohibida_palabra', [`${kind}:3`]]]);
    }
  });

  it('names every offending field and keeps the three rule types apart', () => {
    const campos = [campo('hashtag', 0, '#gratis'), campo('texto_publicacion', 0, 'Garantizado: curamos todo'), campo('texto_en_pantalla', 1, 'Nada')];
    const reglas = [
      { tipo: 'palabra', texto: 'gratis' },
      { tipo: 'promesa', texto: 'garantizado' },
      { tipo: 'tema', texto: 'politica' },
    ] as const;
    expect(fallos(campos, reglas)).toEqual([
      ['regla_prohibida_palabra', ['hashtag:0']],
      ['regla_prohibida_promesa', ['texto_publicacion:0']],
    ]);
  });

  it('ignores a visual-element rule: it is about pictures, not text', () => {
    expect(fallos([campo('texto_publicacion', 0, 'Una playa con una copa de vino')], [{ tipo: 'elemento_visual', texto: 'vino' }])).toEqual([]);
  });

  it('never puts the rule or the text in the parameters', () => {
    const checks = checksReglas([campo('texto_publicacion', 0, 'Todo gratis, solo hoy')], [{ tipo: 'palabra', texto: 'gratis' }]);
    expect(JSON.stringify(checks)).not.toMatch(/gratis|solo hoy/i);
  });
});
