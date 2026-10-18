import { describe, expect, it } from 'vitest';
import { makeLibrary, makeMedia } from '../../../tests/utils/briefFixtures.js';
import { selectCandidateMedia } from './candidates.js';
import { parseFfprobeOutput } from '../../lib/media/probe/index.js';
import { MAX_CANDIDATOS, MIN_DURACION_VIDEO_MS } from './limits.js';

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
    // A story takes photos only until stories with video are produced.
    expect(new Set(ids('historia'))).toEqual(new Set(['foto']));
    expect(ids('historia')).toHaveLength(6);
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

  it('offers only photos for a story, however good the videos are (no brief may pick a video production would refuse)', () => {
    const vertical = makeMedia({ n: 5, tipo: 'video', ancho: 1080, alto: 1920, duracion_ms: 20_000, etiquetas: ['café', 'origen'] });
    const uhd = makeMedia({ n: 6, tipo: 'video', ancho: 3840, alto: 2160, duracion_ms: 20_000 });
    const photoOk = foto(3000, 2000, 1);
    const photoSmall = foto(640, 480, 2);
    for (const red of ['instagram', 'facebook'] as const) {
      expect(ids(selectCandidateMedia({ media: [vertical, uhd, photoSmall, photoOk], pieza: para('historia', red), reglas: [] })), red).toEqual([photoOk.id]);
    }
    // Also without a network, and when there are only videos: nothing is offered.
    const { red: _red, ...sinRed } = para('historia');
    expect(ids(selectCandidateMedia({ media: [vertical, uhd, photoOk], pieza: sinRed, reglas: [] }))).toEqual([photoOk.id]);
    expect(selectCandidateMedia({ media: [vertical, uhd], pieza: para('historia'), reglas: [] })).toEqual([]);
    // Reels still take only videos.
    expect(new Set(ids(selectCandidateMedia({ media: [vertical, uhd, photoOk], pieza: para('reel'), reglas: [] })))).toEqual(new Set([vertical.id, uhd.id]));
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

describe('selectCandidateMedia: videos of a reel (same upscale rule, and long enough)', () => {
  const reel = (red: 'instagram' | 'facebook' | 'tiktok' | 'youtube' = 'instagram') => ({ red, formato: 'reel' as const, pilar: 'Origen del café', idea: 'Un vistazo al origen' });
  const video = (ancho: number, alto: number, n = 0, duracion_ms = 10_000) => makeMedia({ n, tipo: 'video', ancho, alto, duracion_ms });
  const ids = (media: { id: string }[]) => media.map((m) => m.id);

  it('offers vertical and 4K clips and drops the ones that would be enlarged by more than 1.5 times', () => {
    const vertical = video(1080, 1920, 0);
    const uhd = video(3840, 2160, 1); // cover crop 1215x2160, scaled down
    const fullHdLandscape = video(1920, 1080, 2); // 1920 / 1080 = 1.78 times
    const tiny = video(640, 360, 3);
    const result = selectCandidateMedia({ media: [vertical, uhd, fullHdLandscape, tiny], pieza: reel(), reglas: [] });
    expect(new Set(ids(result))).toEqual(new Set([vertical.id, uhd.id]));
    for (const red of ['facebook', 'tiktok', 'youtube'] as const) {
      expect(new Set(ids(selectCandidateMedia({ media: [vertical, uhd, fullHdLandscape, tiny], pieza: reel(red), reglas: [] }))), red).toEqual(new Set([vertical.id, uhd.id]));
    }
  });

  it('keeps a clip at exactly 1.5 times and drops one just under it', () => {
    const exact = video(720, 1280, 0);
    const justUnder = video(719, 1279, 1);
    expect(ids(selectCandidateMedia({ media: [exact, justUnder], pieza: reel(), reglas: [] }))).toEqual([exact.id]);
  });

  it('drops a clip shorter than 2 seconds, keeps one of exactly 2', () => {
    const short = video(1080, 1920, 0, 1999);
    const enough = video(1080, 1920, 1, 2000);
    expect(ids(selectCandidateMedia({ media: [short, enough], pieza: reel(), reglas: [] }))).toEqual([enough.id]);
    expect(MIN_DURACION_VIDEO_MS).toBe(2000);
  });

  it('does not filter when the network is not given, but still wants a useful duration', () => {
    const tiny = video(640, 360, 0);
    const short = video(640, 360, 1, 500);
    const { red: _red, ...sinRed } = reel();
    expect(ids(selectCandidateMedia({ media: [tiny, short], pieza: sinRed, reglas: [] }))).toEqual([tiny.id]);
  });

  it('judges the DISPLAYED size: a phone clip coded 1920x1080 with a 90 degree display matrix is a vertical 1080x1920', () => {
    const ffprobeJson = (rotation: number) =>
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, duration: '10.000000', side_data_list: [{ side_data_type: 'Display Matrix', rotation }] }],
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.000000', tags: { major_brand: 'isom' } },
      });
    const asStored = (rotation: number, n: number) => {
      const probed = parseFfprobeOutput(ffprobeJson(rotation));
      return makeMedia({ n, tipo: 'video', ancho: probed.width, alto: probed.height, duracion_ms: probed.durationMs });
    };
    const portrait = asStored(-90, 0); // what a phone held upright records
    const upsideDownLandscape = asStored(180, 1); // coded landscape, shown landscape
    expect([portrait.ancho, portrait.alto]).toEqual([1080, 1920]);
    expect([upsideDownLandscape.ancho, upsideDownLandscape.alto]).toEqual([1920, 1080]);
    expect(ids(selectCandidateMedia({ media: [portrait, upsideDownLandscape], pieza: reel(), reglas: [] }))).toEqual([portrait.id]);
  });
});
