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

describe('selectCandidateMedia: photos too small for the slide (production would refuse them)', () => {
  const para = (formato: 'reel' | 'carrusel' | 'post' | 'historia', red: 'instagram' | 'facebook' | 'tiktok' | 'youtube' = 'instagram') => ({
    red,
    formato,
    pilar: 'Origen del café',
    idea: 'Un vistazo al origen de nuestros granos',
  });
  const foto = (ancho: number, alto: number, n = 0) => makeMedia({ n, tipo: 'foto', ancho, alto });
  const ids = (media: { id: string }[]) => media.map((m) => m.id);

  it('drops a photo that would be enlarged by more than MAX_UPSCALE for a 4:5 slide, story and post', () => {
    const seedPhoto = foto(640, 480); // the seed photos: 1350 / 480 = 2.8 times
    const big = foto(3000, 2000, 1);
    for (const formato of ['carrusel', 'post', 'historia'] as const) {
      expect(ids(selectCandidateMedia({ media: [seedPhoto, big], pieza: para(formato), reglas: [] })), formato).toEqual([big.id]);
    }
    expect(ids(selectCandidateMedia({ media: [seedPhoto, big], pieza: para('carrusel', 'facebook'), reglas: [] }))).toEqual([big.id]);
  });

  it('keeps a photo at exactly 1.5 times and drops one just under it', () => {
    const exact = foto(720, 900);
    const justUnder = foto(719, 899, 1);
    expect(ids(selectCandidateMedia({ media: [exact, justUnder], pieza: para('carrusel'), reglas: [] }))).toEqual([exact.id]);
  });

  it('judges the limiting dimension, not the larger one', () => {
    const wideButShort = foto(6000, 600); // 1350 / 600 = 2.25 times
    const wideAndTall = foto(6000, 1000, 1);
    expect(ids(selectCandidateMedia({ media: [wideButShort, wideAndTall], pieza: para('carrusel'), reglas: [] }))).toEqual([wideAndTall.id]);
  });

  it('never judges videos (they are 7b)', () => {
    const tinyVideo = makeMedia({ n: 5, tipo: 'video', ancho: 160, alto: 90 });
    expect(ids(selectCandidateMedia({ media: [tinyVideo], pieza: para('reel'), reglas: [] }))).toEqual([tinyVideo.id]);
    expect(ids(selectCandidateMedia({ media: [tinyVideo, foto(640, 480)], pieza: para('historia'), reglas: [] }))).toEqual([tinyVideo.id]);
  });

  it('does not filter when the network is not given or the pair has no size', () => {
    const tiny = foto(640, 480);
    const { red: _red, ...sinRed } = para('carrusel');
    expect(ids(selectCandidateMedia({ media: [tiny], pieza: sinRed, reglas: [] }))).toEqual([tiny.id]);
    expect(ids(selectCandidateMedia({ media: [tiny], pieza: para('carrusel', 'tiktok'), reglas: [] }))).toEqual([tiny.id]);
  });

  it('applies the 12-candidate limit after the filter, so it counts only usable photos', () => {
    const tiny = Array.from({ length: 5 }, (_v, n) => foto(640, 480, 20 + n)); // the newest ones, all too small
    const big = Array.from({ length: 4 }, (_v, n) => foto(3000, 2000, n));
    const result = selectCandidateMedia({ media: [...tiny, ...big], pieza: para('carrusel'), reglas: [], limit: 3 });
    expect(result).toHaveLength(3);
    expect(result.every((m) => m.ancho === 3000)).toBe(true);
  });

  it('keeps the ranking of the photos that stay', () => {
    const porEtiqueta = makeMedia({ n: 1, tipo: 'foto', ancho: 3000, alto: 2000, etiquetas: ['café', 'origen'] });
    const sinPuntos = makeMedia({ n: 9, tipo: 'foto', ancho: 3000, alto: 2000 });
    const chicaConPuntos = makeMedia({ n: 2, tipo: 'foto', ancho: 640, alto: 480, etiquetas: ['café', 'origen'] });
    expect(ids(selectCandidateMedia({ media: [sinPuntos, chicaConPuntos, porEtiqueta], pieza: para('carrusel'), reglas: [] }))).toEqual([porEtiqueta.id, sinPuntos.id]);
  });
});
