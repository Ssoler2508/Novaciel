import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { UnsupportedGlyphsError } from './errors.js';
import {
  assertGlifosSoportados,
  COBERTURA_INTER_LATIN,
  contarGlifosNoSoportados,
  directorioDeFuentes,
  esTextoSoportado,
  FUENTE_POR_DEFECTO,
  registrarFuentes,
} from './fonts.js';

describe('the bundled fonts', () => {
  it('are found with their license, and the license is the OFL of the Inter Project', () => {
    const dir = directorioDeFuentes();
    for (const file of ['inter-latin-400-normal.woff2', 'inter-latin-700-normal.woff2', 'OFL.txt', 'README.md']) {
      expect(existsSync(path.join(dir, file)), file).toBe(true);
    }
    const license = readFileSync(path.join(dir, 'OFL.txt'), 'utf8');
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(license).toContain('Copyright 2016 The Inter Project Authors');
  });

  it('register once under the family "Inter" (calling again is harmless)', () => {
    registrarFuentes();
    registrarFuentes();
    expect(FUENTE_POR_DEFECTO).toBe('Inter');
    expect(GlobalFonts.families.some((family) => family.family === 'Inter')).toBe(true);
  });

  it('draw accented Spanish text, and bold is wider than regular', () => {
    registrarFuentes();
    const ctx = createCanvas(10, 10).getContext('2d');
    const width = (weight: number, text: string) => {
      ctx.font = `${weight} 40px "Inter"`;
      return ctx.measureText(text).width;
    };
    const text = 'Pásate por tu café ¿¡ñ';
    expect(width(400, text)).toBeGreaterThan(200);
    expect(width(700, text)).toBeGreaterThan(width(400, text));
    // Accented letters are not zero-width or missing: they measure like their plain letter, give or take.
    expect(width(700, 'é')).toBeGreaterThan(10);
    expect(Math.abs(width(700, 'é') - width(700, 'e'))).toBeLessThan(4);
  });
});

describe('glyph coverage', () => {
  it('accepts Spanish, English, Portuguese, French and Italian text, the euro sign and punctuation', () => {
    for (const text of [
      'Pásate por tu café ¿¡ñ €',
      'Hecho con calma — como siempre… “gracias”',
      'ÁÉÍÓÚÜÑ áéíóúüñ',
      'Coração, ação, não',
      "Crème brûlée à l'œuvre",
      'Così è già più tardi',
      'Precio: 6.000 – 8.000 €™',
      'Line one\nLine two\ttab',
      '',
    ]) {
      expect(esTextoSoportado(text), text).toBe(true);
      expect(contarGlifosNoSoportados(text)).toBe(0);
      expect(() => assertGlifosSoportados(text)).not.toThrow();
    }
  });

  it('refuses emoji and other scripts, counting characters (not UTF-16 units)', () => {
    expect(contarGlifosNoSoportados('Café ☕')).toBe(1);
    expect(contarGlifosNoSoportados('Hola 😀😀 mundo')).toBe(2);
    expect(contarGlifosNoSoportados('漢字 Привет')).toBe(8);
    expect(contarGlifosNoSoportados('👩‍🍳')).toBe(2); // two emoji joined; the joiner U+200D is punctuation the font has
    expect(esTextoSoportado('Ωmega')).toBe(false);
    expect(() => assertGlifosSoportados('hola ☕')).toThrow(UnsupportedGlyphsError);
  });

  it('the error carries a count and never the text', () => {
    try {
      assertGlifosSoportados('SECRETO ☕ ☕');
      expect.unreachable();
    } catch (error) {
      expect((error as UnsupportedGlyphsError).cantidad).toBe(2);
      expect((error as Error).message).not.toContain('SECRETO');
    }
  });

  it('holds exactly the unicode-range of the Inter Latin subset', () => {
    expect(COBERTURA_INTER_LATIN).toHaveLength(19);
    const edges = [0x00ff, 0x0100, 0x0130, 0x0131, 0x0132, 0x0152, 0x0153, 0x0154, 0x2000, 0x206f, 0x2070, 0x20ab, 0x20ac, 0x20ad, 0x2122, 0xfffd];
    const expected = [true, false, false, true, false, true, true, false, true, true, false, false, true, false, true, true];
    edges.forEach((codePoint, i) => expect(esTextoSoportado(String.fromCodePoint(codePoint)), `U+${codePoint.toString(16)}`).toBe(expected[i]));
  });
});
