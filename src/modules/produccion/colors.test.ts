import { describe, expect, it } from 'vitest';
import {
  CONTRASTE_MINIMO,
  contraste,
  contrastePeorCaso,
  elegirColores,
  luminanciaRelativa,
  mezclar,
  parseHex,
  SCRIM_ALFA,
  SCRIM_RESPALDO,
  TEXTO_RESPALDO,
  toHex,
} from './colors.js';

const hex = (value: string) => parseHex(value)!;

describe('parseHex', () => {
  it('reads #RGB and #RRGGBB in any case', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#F80')).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseHex('#6F4E37')).toEqual({ r: 0x6f, g: 0x4e, b: 0x37 });
    expect(parseHex('#6f4e37')).toEqual({ r: 0x6f, g: 0x4e, b: 0x37 });
  });

  it('ignores anything else', () => {
    for (const bad of ['', 'fff', '#ffff', '#fffff', '#fffffff', '#ggg', '#12345g', 'red', 'rgb(1,2,3)', ' #fff', '#fff ', null, undefined, 5, {}, ['#fff']]) {
      expect(parseHex(bad), String(bad)).toBeNull();
    }
  });

  it('toHex writes lower-case #rrggbb and clamps', () => {
    expect(toHex({ r: 255, g: 136, b: 0 })).toBe('#ff8800');
    expect(toHex({ r: -4, g: 300, b: 15.6 })).toBe('#00ff10');
  });
});

describe('WCAG contrast', () => {
  it('has the known extremes and values', () => {
    expect(luminanciaRelativa(hex('#000000'))).toBe(0);
    expect(luminanciaRelativa(hex('#ffffff'))).toBeCloseTo(1);
    expect(contraste(hex('#000000'), hex('#ffffff'))).toBeCloseTo(21);
    expect(contraste(hex('#ffffff'), hex('#ffffff'))).toBeCloseTo(1);
    expect(contraste(hex('#ffffff'), hex('#000000'))).toBeCloseTo(21); // symmetric
  });

  it('puts the classic 4.5 boundary where WCAG puts it', () => {
    expect(contraste(hex('#767676'), hex('#ffffff'))).toBeGreaterThanOrEqual(4.5);
    expect(contraste(hex('#767676'), hex('#ffffff'))).toBeCloseTo(4.54, 2);
    expect(contraste(hex('#777777'), hex('#ffffff'))).toBeLessThan(4.5);
    expect(contraste(hex('#777777'), hex('#ffffff'))).toBeCloseTo(4.48, 2);
  });

  it('mixes a color over another by its opacity', () => {
    expect(mezclar(hex('#000000'), hex('#ffffff'), 0.5)).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
    expect(mezclar(hex('#102030'), hex('#ffffff'), 1)).toEqual(hex('#102030'));
    expect(mezclar(hex('#102030'), hex('#ffffff'), 0)).toEqual(hex('#ffffff'));
  });

  it('the worst case is the lower of the black-photo and white-photo contrasts', () => {
    const texto = hex('#ffffff');
    const scrim = hex('#1a1a1a');
    const sobreNegro = contraste(texto, mezclar(scrim, hex('#000000'), SCRIM_ALFA));
    const sobreBlanco = contraste(texto, mezclar(scrim, hex('#ffffff'), SCRIM_ALFA));
    expect(contrastePeorCaso(texto, scrim)).toBe(Math.min(sobreNegro, sobreBlanco));
    expect(sobreBlanco).toBeLessThan(sobreNegro); // a white photo is the harder case for light text
    // A plain ratio against the solid scrim would be more optimistic.
    expect(contrastePeorCaso(texto, scrim)).toBeLessThan(contraste(texto, scrim));
  });
});

describe('elegirColores', () => {
  const kit = (colores: unknown) => ({ colores });

  it('uses brand colors for the seed palette, and the pair really passes the worst case', () => {
    const result = elegirColores(kit({ principal: '#6F4E37', secundarios: ['#F5E6D3', '#2B2B2B'], acento: '#E07A1F' }));
    expect(result.origen).toBe('marca');
    expect(result.alfa).toBe(SCRIM_ALFA);
    expect(result.contraste).toBeGreaterThanOrEqual(CONTRASTE_MINIMO);
    expect(contrastePeorCaso(hex(result.texto), hex(result.scrim))).toBeCloseTo(result.contraste);
    // The brown principal is skipped: over a white photo its scrim is too light for any text color
    // (4.3 for white text), so the strict worst-case rule moves on to the cream with the dark brand text.
    expect(contrastePeorCaso(hex('#ffffff'), hex('#6f4e37'))).toBeLessThan(CONTRASTE_MINIMO);
    expect(result).toMatchObject({ scrim: '#f5e6d3', texto: '#2b2b2b' });
  });

  it('prefers a brand color for the text over white and black', () => {
    const result = elegirColores(kit({ principal: '#1b1b3a', secundarios: ['#fdf6e3'], acento: '#ff9f1c' }));
    expect(result.origen).toBe('marca');
    expect(result.scrim).toBe('#1b1b3a');
    expect(result.texto).toBe('#fdf6e3');
  });

  it('tries the next brand color as scrim when the first has no passing text color', () => {
    // A mid grey cannot give 4.5 against any text color in the worst case; the next color can.
    const result = elegirColores(kit({ principal: '#808080', secundarios: ['#101010'], acento: '#ffffff' }));
    expect(result.origen).toBe('marca');
    expect(result.scrim).toBe('#101010');
    expect(result.contraste).toBeGreaterThanOrEqual(CONTRASTE_MINIMO);
  });

  it('falls back to white on a dark scrim when no brand pair reaches 4.5', () => {
    const result = elegirColores(kit({ principal: '#808080', secundarios: ['#888888', '#777777'], acento: '#7f7f7f' }));
    expect(result).toMatchObject({ texto: TEXTO_RESPALDO, scrim: SCRIM_RESPALDO, alfa: SCRIM_ALFA, origen: 'respaldo' });
    expect(result.contraste).toBeGreaterThanOrEqual(CONTRASTE_MINIMO);
  });

  it('falls back when the kit is missing, empty or invalid', () => {
    for (const bad of [undefined, null, {}, kit(undefined), kit(null), kit({}), kit({ principal: 'rojo', secundarios: 'x', acento: 5 }), kit('colores'), 'kit', 7, []]) {
      expect(elegirColores(bad), JSON.stringify(bad)).toMatchObject({ texto: TEXTO_RESPALDO, scrim: SCRIM_RESPALDO, origen: 'respaldo' });
    }
  });

  it('ignores invalid hex values and duplicates, and reads short and upper-case hex', () => {
    const result = elegirColores(kit({ principal: 'no es un color', secundarios: ['#111', '#111111', 42, null], acento: '#FFF' }));
    expect(result.origen).toBe('marca');
    expect(result.scrim).toBe('#111111');
    expect(result.texto).toBe('#ffffff');
  });

  it('the fallback pair itself passes with room to spare', () => {
    expect(contrastePeorCaso(hex(TEXTO_RESPALDO), hex(SCRIM_RESPALDO))).toBeGreaterThan(7);
  });

  it('always returns a pair with a worst-case contrast of at least 4.5, over thousands of random palettes (seeded property)', () => {
    let seed = 20261016;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const color = () => `#${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}`;
    let brand = 0;
    let fallback = 0;
    for (let i = 0; i < 3000; i++) {
      const palette = kit({ principal: color(), secundarios: Array.from({ length: Math.floor(random() * 4) }, color), acento: color() });
      const result = elegirColores(palette);
      expect(contrastePeorCaso(hex(result.texto), hex(result.scrim), result.alfa), JSON.stringify(palette)).toBeGreaterThanOrEqual(CONTRASTE_MINIMO);
      expect(result.contraste).toBeGreaterThanOrEqual(CONTRASTE_MINIMO);
      if (result.origen === 'marca') brand++;
      else fallback++;
    }
    // Both outcomes really happen in the sample, so the property is not vacuous.
    expect(brand).toBeGreaterThan(100);
    expect(fallback).toBeGreaterThan(0);
  });
});
