import { describe, expect, it } from 'vitest';
import type { CodigoQC } from './catalogo.js';
import { checksTextos, type EntradaTextos } from './textos.js';
import type { CheckQC } from './tipos.js';

const carrusel: EntradaTextos = {
  formato: 'carrusel',
  textoPublicacion: 'Una mañana tranquila en el café',
  hashtags: ['#cafe', '#aurora_2'],
  textosAlternativos: ['Mesa uno', 'Mesa dos', 'Mesa tres', 'Mesa cuatro', 'Mesa cinco'],
  ubicacion: 'Centro',
  numArchivos: 5,
  numEscenasReel: null,
};
const reel: EntradaTextos = { ...carrusel, formato: 'reel', textosAlternativos: [''], numArchivos: 1, numEscenasReel: 4 };

const resultado = (checks: CheckQC[], codigo: CodigoQC) => checks.find((c) => c.codigo === codigo)!;
const falla = (entrada: EntradaTextos) => checksTextos(entrada).filter((c) => c.resultado !== 'pasa').map((c) => c.codigo);

describe('checksTextos', () => {
  it('returns one check per code, in a fixed order, and all pass for a valid carousel and a valid reel', () => {
    for (const entrada of [carrusel, reel]) {
      const checks = checksTextos(entrada);
      expect(checks.map((c) => c.codigo)).toEqual([
        'texto_publicacion_largo',
        'hashtags_cantidad',
        'hashtags_forma',
        'texto_alternativo_largo',
        'texto_alternativo_falta',
        'ubicacion_larga',
        'diapositivas_cantidad',
      ]);
      expect(checks.every((c) => c.resultado === 'pasa')).toBe(true);
    }
  });

  it('accepts the limits exactly and refuses one more', () => {
    expect(falla({ ...carrusel, textoPublicacion: 'a'.repeat(2000) })).toEqual([]);
    expect(falla({ ...carrusel, textoPublicacion: 'a'.repeat(2001) })).toEqual(['texto_publicacion_largo']);
    expect(falla({ ...carrusel, hashtags: Array.from({ length: 10 }, (_v, i) => `#h${i}`) })).toEqual([]);
    expect(falla({ ...carrusel, hashtags: Array.from({ length: 11 }, (_v, i) => `#h${i}`) })).toEqual(['hashtags_cantidad']);
    expect(falla({ ...carrusel, textosAlternativos: carrusel.textosAlternativos.map(() => 'a'.repeat(100)) })).toEqual([]);
    expect(falla({ ...carrusel, textosAlternativos: ['a'.repeat(101), ...carrusel.textosAlternativos.slice(1)] })).toEqual(['texto_alternativo_largo']);
    expect(falla({ ...carrusel, ubicacion: 'a'.repeat(100) })).toEqual([]);
    expect(falla({ ...carrusel, ubicacion: 'a'.repeat(101) })).toEqual(['ubicacion_larga']);
    expect(falla({ ...carrusel, ubicacion: null })).toEqual([]);
  });

  it('reports the position of the offending hashtags and alt texts, never their text', () => {
    const checks = checksTextos({ ...carrusel, hashtags: ['#bien', 'sin_numeral', '#dos palabras', '#'], textosAlternativos: ['ok', 'b'.repeat(101), 'ok', 'c'.repeat(150), 'ok'] });
    expect(resultado(checks, 'hashtags_forma')).toMatchObject({ resultado: 'no_pasa', parametros: { indices: [1, 2, 3] } });
    expect(resultado(checks, 'texto_alternativo_largo')).toMatchObject({ resultado: 'no_pasa', parametros: { indices: [1, 3], maximo: 100 } });
  });

  it.each([
    ['without #', '#cafe', 'cafe'],
    ['with a space', '#cafe', '#cafe con leche'],
    ['with punctuation', '#cafe', '#cafe!'],
    ['empty after the #', '#cafe', '#'],
  ])('refuses a hashtag %s', (_nombre, _bien, malo) => {
    expect(falla({ ...carrusel, hashtags: [malo] })).toEqual(['hashtags_forma']);
  });

  it('accepts hashtags with accents, digits and underscores', () => {
    expect(falla({ ...carrusel, hashtags: ['#café', '#año_2026', '#ÑANDÚ'] })).toEqual([]);
  });

  it('needs an alt text for every file in carousel, post and story, and not in a reel', () => {
    expect(falla({ ...carrusel, textosAlternativos: ['a', 'b', '', 'd', 'e'] })).toEqual(['texto_alternativo_falta']);
    expect(falla({ ...carrusel, textosAlternativos: ['a', 'b', '   ', 'd', 'e'] })).toEqual(['texto_alternativo_falta']);
    expect(falla({ ...carrusel, textosAlternativos: ['a', 'b'] })).toEqual(['texto_alternativo_falta']);
    expect(resultado(checksTextos({ ...carrusel, textosAlternativos: ['a', 'b', '', 'd'] }), 'texto_alternativo_falta').parametros).toEqual({ indices: [2, 4] });
    expect(falla({ ...carrusel, formato: 'post', numArchivos: 1, textosAlternativos: [''] })).toEqual(['texto_alternativo_falta']);
    expect(falla({ ...carrusel, formato: 'historia', numArchivos: 2, textosAlternativos: ['a', ''] })).toEqual(['texto_alternativo_falta']);
    expect(falla({ ...reel, textosAlternativos: [] })).toEqual([]);
  });

  it.each([
    ['carousel with 4 slides', { formato: 'carrusel', numArchivos: 4 }, true],
    ['carousel with 5 slides', { formato: 'carrusel', numArchivos: 5 }, false],
    ['carousel with 10 slides', { formato: 'carrusel', numArchivos: 10 }, false],
    ['carousel with 11 slides', { formato: 'carrusel', numArchivos: 11 }, true],
    ['post with 2 files', { formato: 'post', numArchivos: 2 }, true],
    ['post with 1 file', { formato: 'post', numArchivos: 1 }, false],
    ['story with 0 files', { formato: 'historia', numArchivos: 0 }, true],
    ['story with 3 files', { formato: 'historia', numArchivos: 3 }, false],
    ['story with 4 files', { formato: 'historia', numArchivos: 4 }, true],
    ['reel with 2 scenes', { formato: 'reel', numArchivos: 1, numEscenasReel: 2 }, true],
    ['reel with 3 scenes', { formato: 'reel', numArchivos: 1, numEscenasReel: 3 }, false],
    ['reel with 6 scenes', { formato: 'reel', numArchivos: 1, numEscenasReel: 6 }, false],
    ['reel with 7 scenes', { formato: 'reel', numArchivos: 1, numEscenasReel: 7 }, true],
    ['reel with unknown scenes', { formato: 'reel', numArchivos: 1, numEscenasReel: null }, true],
  ] as const)('slides and scenes: %s', (_nombre, cambios, debeFallar) => {
    const alts = Array.from({ length: cambios.numArchivos }, (_v, i) => `Alt ${i}`);
    const checks = checksTextos({ ...carrusel, ...cambios, textosAlternativos: alts });
    expect(resultado(checks, 'diapositivas_cantidad').resultado).toBe(debeFallar ? 'no_pasa' : 'pasa');
  });

  it('counts the scenes of a reel, not its single file', () => {
    const checks = checksTextos({ ...reel, numArchivos: 1, numEscenasReel: 4 });
    expect(resultado(checks, 'diapositivas_cantidad').parametros).toEqual({ cantidad: 4, minimo: 3, maximo: 6 });
  });
});
