import { describe, expect, it, vi } from 'vitest';
import { posicionDelBloque } from './bloqueTexto.js';
import { TextDoesNotFitError } from './errors.js';
import { distribuirPalabras } from './lineasPalabras.js';
import { zonaSegura } from './safeArea.js';
import { layoutText, type Medir } from './textLayout.js';
import { palabrasDe } from './tiemposPalabras.js';

// A fake measure: every character is half as wide as the font size. No canvas is needed.
const medir: Medir = (texto, tamano) => [...texto].length * tamano * 0.5;
const base = { ancho: 1080, alto: 1920, medir } as const;

describe('distribuirPalabras', () => {
  it('lays the whole text out once and gives every word its place, in order', () => {
    const texto = 'Cada mañana tostamos el café de origen colombiano en nuestra casa del barrio';
    const r = distribuirPalabras({ ...base, texto });
    const planas = r.lineas.flat();
    expect(planas.map((p) => p.texto)).toEqual(palabrasDe(texto));
    expect(planas.map((p) => p.indice)).toEqual(planas.map((_p, i) => i));
    expect(r.lineas.length).toBeGreaterThan(1);
    expect(r.posicion).toBe('abajo');
  });

  it('reuses the 7a layout: the same size and lines layoutText gives for the same box', () => {
    const texto = 'Pan recién horneado todos los días desde las seis de la mañana';
    const zona = zonaSegura(1080, 1920, 'reel');
    const esperado = layoutText({ texto, maxAncho: zona.ancho, maxAlto: zona.alto * 0.45, medir, tamanoMax: 72, tamanoMin: 36, paso: 2, interlineado: 1.25, maxLineas: 8 });
    const r = distribuirPalabras({ ...base, texto });
    expect(r.tamano).toBe(esperado.tamano);
    expect(r.interlineadoPx).toBe(esperado.interlineadoPx);
    expect(r.altoBloque).toBe(esperado.altoBloque);
    expect(r.lineas.map((l) => l.map((p) => p.texto).join(' '))).toEqual(esperado.lineas);
  });

  it('puts the block and its band where the static overlay puts them (shared geometry)', () => {
    const r = distribuirPalabras({ ...base, texto: 'Hola mundo' });
    const zona = zonaSegura(1080, 1920, 'reel');
    const g = posicionDelBloque(zona, 1920, r);
    expect(r.bloqueArriba).toBe(g.bloqueArriba);
    expect(r.banda).toEqual({ y: g.bandaArriba, alto: g.bandaAbajo - g.bandaArriba });
    // Inside the canvas and around the block.
    expect(r.banda.y).toBeGreaterThanOrEqual(0);
    expect(r.banda.y + r.banda.alto).toBeLessThanOrEqual(1920);
    expect(r.bloqueArriba + r.altoBloque).toBeLessThanOrEqual(zona.y + zona.alto + 1e-6);
  });

  it('keeps the text inside the safe zone, wide lines included', () => {
    const zona = zonaSegura(1080, 1920, 'reel');
    const r = distribuirPalabras({ ...base, texto: 'Palabras largas internacionalizacion constitucionalmente anticonstitucional ' + 'x '.repeat(20) });
    for (const linea of r.lineas) expect(medir(linea.map((p) => p.texto).join(' '), r.tamano)).toBeLessThanOrEqual(zona.ancho + 1e-6);
    expect(r.bloqueArriba).toBeGreaterThanOrEqual(zona.y - 1e-6);
  });

  it('shrinks the size for a long text and refuses, never cuts, what cannot fit', () => {
    const corto = distribuirPalabras({ ...base, texto: 'Hola' });
    const largo = distribuirPalabras({ ...base, texto: 'palabra '.repeat(24) });
    expect(largo.tamano).toBeLessThan(corto.tamano);
    expect(() => distribuirPalabras({ ...base, texto: 'palabra '.repeat(200) })).toThrow(TextDoesNotFitError);
    expect(() => distribuirPalabras({ ...base, texto: 'a'.repeat(300) })).toThrow(expect.objectContaining({ reason: 'palabra_mas_ancha_que_la_caja' }));
    expect(() => distribuirPalabras({ ...base, texto: '   ' })).toThrow(expect.objectContaining({ reason: 'texto_vacio' }));
  });

  it('keeps hard line breaks of the text and still numbers the words in order', () => {
    const r = distribuirPalabras({ ...base, texto: 'Primera línea\nSegunda línea corta' });
    expect(r.lineas.map((l) => l.map((p) => p.texto).join(' '))).toEqual(['Primera línea', 'Segunda línea corta']);
    expect(r.lineas.flat().map((p) => p.indice)).toEqual([0, 1, 2, 3, 4]);
  });

  it('normalizes the text (NFD input gives the same lines as NFC)', () => {
    const nfc = distribuirPalabras({ ...base, texto: 'Niño canción mañana' });
    const nfd = distribuirPalabras({ ...base, texto: 'Niño canción mañana'.normalize('NFD') });
    expect(nfd).toEqual(nfc);
  });

  it('a title card is centered in the safe zone with a larger size range', () => {
    const abajo = distribuirPalabras({ ...base, texto: 'Hola' });
    const titulo = distribuirPalabras({ ...base, texto: 'Hola', escalaTamano: 1.25, posicion: 'centro' });
    const zona = zonaSegura(1080, 1920, 'reel');
    expect(titulo.tamano).toBeGreaterThan(abajo.tamano);
    expect(titulo.posicion).toBe('centro');
    const centroZona = zona.y + zona.alto / 2;
    expect(Math.abs(titulo.bloqueArriba + titulo.altoBloque / 2 - centroZona)).toBeLessThan(1);
  });

  it('measures only through the function it is given (no canvas)', () => {
    const espia = vi.fn(medir);
    distribuirPalabras({ ...base, texto: 'Hola mundo', medir: espia });
    expect(espia).toHaveBeenCalled();
  });

  it('refuses a bad canvas with the 7a error', () => {
    expect(() => distribuirPalabras({ ...base, texto: 'Hola', ancho: 0 })).toThrow(expect.objectContaining({ name: 'InvalidSizeError' }));
  });
});
