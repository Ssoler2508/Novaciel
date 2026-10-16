import { describe, expect, it } from 'vitest';
import { InvalidSizeError, TextDoesNotFitError } from './errors.js';
import { zonaSegura } from './safeArea.js';
import { layoutText, type Medir } from './textLayout.js';

/** Every character is half the font size wide. */
const mono: Medir = (texto, tamano) => [...texto].length * tamano * 0.5;
/** A proportional font: narrow letters (i l t f j r .) 0.3, wide ones (m w M W) 0.8, spaces 0.25, the rest 0.5. */
const proportional: Medir = (texto, tamano) =>
  [...texto].reduce((sum, ch) => sum + tamano * (/[ilftjr.,]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.8 : ch === ' ' ? 0.25 : 0.5), 0);

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TextDoesNotFitError);
    return error as TextDoesNotFitError;
  }
  throw new Error('it did not throw');
};

describe('layoutText', () => {
  it('keeps the largest size when the text fits', () => {
    const layout = layoutText({ texto: 'Hola mundo', maxAncho: 800, maxAlto: 300, medir: mono });
    expect(layout).toMatchObject({ tamano: 72, lineas: ['Hola mundo'] });
    expect(layout.interlineadoPx).toBeCloseTo(90);
    expect(layout.altoBloque).toBeCloseTo(90);
  });

  it('wraps at word boundaries and never cuts a word', () => {
    // 72 px: 36 px per character; the box holds 10 characters.
    const layout = layoutText({ texto: 'uno dos tres cuatro', maxAncho: 360, maxAlto: 1000, medir: mono, tamanoMin: 72 });
    expect(layout.lineas).toEqual(['uno dos', 'tres', 'cuatro']);
    expect(layout.lineas.join(' ')).toBe('uno dos tres cuatro');
  });

  it('shrinks step by step until the text fits, choosing the LARGEST size that fits', () => {
    const texto = 'Hecho con calma, como siempre y con cariño de barrio';
    const input = { texto, maxAncho: 700, maxAlto: 200, medir: proportional };
    const layout = layoutText(input);
    expect(layout.tamano).toBeLessThan(72);
    expect(layout.tamano).toBeGreaterThanOrEqual(36);
    expect(layout.altoBloque).toBeLessThanOrEqual(200);
    // Every larger size (in steps of 2) really does not fit.
    for (let t = layout.tamano + 2; t <= 72; t += 2) {
      expect(() => layoutText({ ...input, tamanoMax: t, tamanoMin: t }), `size ${t}`).toThrow(TextDoesNotFitError);
    }
    // And the chosen one fits when asked for exactly.
    expect(layoutText({ ...input, tamanoMax: layout.tamano, tamanoMin: layout.tamano }).lineas).toEqual(layout.lineas);
    for (const linea of layout.lineas) expect(proportional(linea, layout.tamano)).toBeLessThanOrEqual(700);
  });

  it('keeps the words of the text in order, with spaces collapsed and the ends trimmed', () => {
    const layout = layoutText({ texto: '  uno   dos\t tres  ', maxAncho: 2000, maxAlto: 500, medir: mono });
    expect(layout.lineas).toEqual(['uno dos tres']);
  });

  it('keeps the hard line breaks of the text and drops empty lines', () => {
    const layout = layoutText({ texto: 'Primera línea\r\n\r\nSegunda\nTercera', maxAncho: 2000, maxAlto: 1000, medir: mono });
    expect(layout.lineas).toEqual(['Primera línea', 'Segunda', 'Tercera']);
  });

  it('lays out accented Spanish text', () => {
    const layout = layoutText({ texto: '¿Qué tal un café con leche y una porción de torta de zanahoria?', maxAncho: 900, maxAlto: 500, medir: proportional });
    expect(layout.lineas.join(' ')).toBe('¿Qué tal un café con leche y una porción de torta de zanahoria?');
  });

  it('fits exactly at the limit and refuses one pixel short', () => {
    // One line of 10 characters at size 40 is 200 px wide and 50 px high.
    const base = { texto: '0123456789', medir: mono, tamanoMax: 40, tamanoMin: 40 };
    expect(layoutText({ ...base, maxAncho: 200, maxAlto: 50 }).lineas).toEqual(['0123456789']);
    expect(refusal(() => layoutText({ ...base, maxAncho: 199, maxAlto: 50 })).reason).toBe('palabra_mas_ancha_que_la_caja');
    expect(refusal(() => layoutText({ ...base, maxAncho: 200, maxAlto: 49 })).reason).toBe('no_cabe_en_el_alto');
  });

  it('refuses a single word wider than the box at the smallest size, instead of breaking it', () => {
    const error = refusal(() => layoutText({ texto: 'anticonstitucionalmente', maxAncho: 300, maxAlto: 2000, medir: mono }));
    expect(error.reason).toBe('palabra_mas_ancha_que_la_caja');
    expect(error.detalle).toEqual({ tamanoMin: 36 });
    // A long word is fine when a smaller size makes it fit.
    expect(layoutText({ texto: 'anticonstitucionalmente', maxAncho: 300, maxAlto: 2000, medir: mono, tamanoMin: 20 }).tamano).toBeLessThanOrEqual(26);
  });

  it('refuses text that still does not fit at the smallest size, saying how many lines', () => {
    const texto = Array.from({ length: 40 }, () => 'palabra').join(' ');
    const error = refusal(() => layoutText({ texto, maxAncho: 800, maxAlto: 200, medir: mono }));
    expect(error.reason).toBe('no_cabe_en_el_alto');
    expect(error.detalle.lineas).toBeGreaterThan(3);
  });

  it('honours maxLineas', () => {
    const texto = 'uno dos tres cuatro cinco seis siete ocho';
    const free = layoutText({ texto, maxAncho: 300, maxAlto: 5000, medir: mono });
    expect(free.lineas.length).toBeGreaterThan(3);
    const limited = layoutText({ texto, maxAncho: 300, maxAlto: 5000, medir: mono, maxLineas: 3, tamanoMin: 20 });
    expect(limited.lineas.length).toBeLessThanOrEqual(3);
    expect(limited.tamano).toBeLessThan(free.tamano);
    expect(refusal(() => layoutText({ texto, maxAncho: 300, maxAlto: 5000, medir: mono, maxLineas: 1 })).reason).toBe('demasiadas_lineas');
  });

  it('refuses empty text', () => {
    for (const texto of ['', '   ', '\n\n', '\t']) expect(refusal(() => layoutText({ texto, maxAncho: 100, maxAlto: 100, medir: mono })).reason).toBe('texto_vacio');
  });

  it('uses the given size range, step and line height', () => {
    const layout = layoutText({ texto: 'abc', maxAncho: 1000, maxAlto: 1000, medir: mono, tamanoMax: 50, tamanoMin: 10, paso: 5, interlineado: 2 });
    expect(layout).toMatchObject({ tamano: 50, interlineadoPx: 100, altoBloque: 100 });
    // The smallest size is tried even when the step does not land on it.
    const odd = layoutText({ texto: '0123456789', maxAncho: 62, maxAlto: 1000, medir: mono, tamanoMax: 40, tamanoMin: 12, paso: 7 });
    expect(odd.tamano).toBe(12);
  });

  it('rejects impossible parameters', () => {
    const ok = { texto: 'a', maxAncho: 100, maxAlto: 100, medir: mono };
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => layoutText({ ...ok, maxAncho: bad })).toThrow(InvalidSizeError);
      expect(() => layoutText({ ...ok, maxAlto: bad })).toThrow(InvalidSizeError);
      expect(() => layoutText({ ...ok, paso: bad })).toThrow(InvalidSizeError);
      expect(() => layoutText({ ...ok, interlineado: bad })).toThrow(InvalidSizeError);
    }
    expect(() => layoutText({ ...ok, tamanoMax: 10, tamanoMin: 20 })).toThrow(InvalidSizeError);
  });

  it('error messages carry reasons and counts, never the text', () => {
    const error = refusal(() => layoutText({ texto: 'SECRETO-SECRETO-SECRETO', maxAncho: 10, maxAlto: 10, medir: mono }));
    expect(error.message).not.toContain('SECRETO');
    expect(JSON.stringify(error.detalle)).not.toContain('SECRETO');
  });
});

describe('zonaSegura', () => {
  it('leaves a margin on a 4:5 slide', () => {
    expect(zonaSegura(1080, 1350, 'carrusel')).toEqual({ x: 80, y: 100, ancho: 920, alto: 1130 });
    expect(zonaSegura(1080, 1350, 'post')).toEqual({ x: 80, y: 100, ancho: 920, alto: 1130 });
  });

  it('keeps text out of the bands that the buttons cover on vertical full-screen formats', () => {
    expect(zonaSegura(1080, 1920, 'historia')).toEqual({ x: 64, y: 250, ancho: 952, alto: 1330 });
    expect(zonaSegura(1080, 1920, 'reel')).toEqual({ x: 64, y: 250, ancho: 952, alto: 1330 });
  });

  it('scales with the canvas width and always stays inside the canvas', () => {
    const half = zonaSegura(540, 675, 'carrusel');
    expect(half).toEqual({ x: 40, y: 50, ancho: 460, alto: 565 });
    for (const formato of ['carrusel', 'post', 'historia', 'reel'] as const) {
      const [ancho, alto] = formato === 'carrusel' || formato === 'post' ? [1080, 1350] : [1080, 1920];
      const zona = zonaSegura(ancho, alto, formato);
      expect(zona.x).toBeGreaterThan(0);
      expect(zona.y).toBeGreaterThan(0);
      expect(zona.x + zona.ancho).toBeLessThan(ancho);
      expect(zona.y + zona.alto).toBeLessThan(alto);
    }
  });

  it('rejects canvases that are not positive or leave no room', () => {
    for (const bad of [0, -1, Number.NaN]) expect(() => zonaSegura(bad, 1350, 'carrusel')).toThrow(InvalidSizeError);
    expect(() => zonaSegura(1080, 200, 'historia')).toThrow(InvalidSizeError);
  });
});
