import { describe, expect, it } from 'vitest';
import { makeLibrary, makeMedia } from '../../../tests/utils/briefFixtures.js';
import { selectCandidateMedia } from './candidates.js';
import { MAX_CANDIDATOS } from './limits.js';

const pieza = (formato: 'reel' | 'carrusel' | 'post' | 'historia') => ({ formato, pilar: 'Origen del café', idea: 'Un vistazo al origen de nuestros granos' });

describe('selectCandidateMedia', () => {
  it('keeps only the types that fit the format', () => {
    const media = makeLibrary(); // 6 photos, 2 videos
    const ids = (formato: 'reel' | 'carrusel' | 'post' | 'historia') =>
      selectCandidateMedia({ media, pieza: pieza(formato), reglas: [] }).map((m) => m.tipo);
    expect(new Set(ids('reel'))).toEqual(new Set(['video']));
    expect(ids('reel')).toHaveLength(2);
    expect(new Set(ids('carrusel'))).toEqual(new Set(['foto']));
    expect(new Set(ids('post'))).toEqual(new Set(['foto']));
    expect(new Set(ids('historia'))).toEqual(new Set(['foto', 'video']));
    expect(ids('historia')).toHaveLength(8);
  });

  it('returns nothing when the library has nothing that fits', () => {
    const soloFotos = Array.from({ length: 3 }, (_v, n) => makeMedia({ n, tipo: 'foto' }));
    expect(selectCandidateMedia({ media: soloFotos, pieza: pieza('reel'), reglas: [] })).toEqual([]);
    expect(selectCandidateMedia({ media: [], pieza: pieza('carrusel'), reglas: [] })).toEqual([]);
  });

  it('respects the limit (default MAX_CANDIDATOS) and never returns a negative one', () => {
    const media = Array.from({ length: MAX_CANDIDATOS + 5 }, (_v, n) => makeMedia({ n, tipo: 'foto' }));
    expect(selectCandidateMedia({ media, pieza: pieza('carrusel'), reglas: [] })).toHaveLength(MAX_CANDIDATOS);
    expect(selectCandidateMedia({ media, pieza: pieza('carrusel'), reglas: [], limit: 3 })).toHaveLength(3);
    expect(selectCandidateMedia({ media, pieza: pieza('carrusel'), reglas: [], limit: -1 })).toEqual([]);
  });

  it('ranks by tags (2 points) and description (1 point) close to the pillar and the idea, newest first on ties', () => {
    const viejaSinPuntos = makeMedia({ n: 1, etiquetas: ['otro'] });
    const nuevaSinPuntos = makeMedia({ n: 9, etiquetas: ['otro'] });
    const porDescripcion = makeMedia({ n: 2, descripcion: 'Granos tostados sobre la mesa' });
    const porEtiqueta = makeMedia({ n: 3, etiquetas: ['café', 'origen'] });
    const result = selectCandidateMedia({
      media: [viejaSinPuntos, nuevaSinPuntos, porDescripcion, porEtiqueta],
      pieza: pieza('carrusel'),
      reglas: [],
    });
    expect(result.map((m) => m.id)).toEqual([porEtiqueta.id, porDescripcion.id, nuevaSinPuntos.id, viejaSinPuntos.id]);
  });

  it('is deterministic and does not mutate its input', () => {
    const media = Array.from({ length: 6 }, (_v, n) => makeMedia({ n: n % 2, tipo: 'foto' })); // same dates on purpose
    const copy = [...media];
    const a = selectCandidateMedia({ media, pieza: pieza('carrusel'), reglas: [] });
    const b = selectCandidateMedia({ media: [...media].reverse(), pieza: pieza('carrusel'), reglas: [] });
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
    expect(media).toEqual(copy);
  });

  it('drops media that shows a banned visual element (tags or description, accent-insensitive)', () => {
    const oscura = makeMedia({ n: 1, etiquetas: ['Fondos Oscuros'] });
    const oscuraEnTexto = makeMedia({ n: 2, descripcion: 'Una mesa con fondós oscuros al fondo' });
    const buena = makeMedia({ n: 3, etiquetas: ['café'] });
    const reglas = [
      { tipo: 'elemento_visual' as const, texto: 'fondos oscuros' },
      { tipo: 'palabra' as const, texto: 'café' }, // only visual-element rules apply to media
    ];
    expect(selectCandidateMedia({ media: [oscura, oscuraEnTexto, buena], pieza: pieza('carrusel'), reglas }).map((m) => m.id)).toEqual([buena.id]);
  });
});
