import { describe, expect, it } from 'vitest';
import type { HechoPlanner } from '../planificador/types.js';
import { LocucionTextoInvalidoError } from './errors.js';
import { normalizarTextoLocucion, prepararTextoLocucion, type EntradaTextoLocucion } from './textoLocucion.js';

const AHORA = new Date('2026-11-02T12:00:00Z');
const PIEZA = new Date('2026-11-05T15:00:00Z');
const ID_PRECIO = '11111111-1111-4111-8111-111111111111';
const ID_HORARIO = '22222222-2222-4222-8222-222222222222';

const hecho = (id: string, tipo: HechoPlanner['tipo'], enunciado: string, extra: Partial<HechoPlanner> = {}): HechoPlanner => ({
  id,
  tipo,
  enunciado,
  vigente_desde: new Date('2026-01-01T00:00:00Z'),
  vigente_hasta: null,
  ...extra,
});
const HECHOS = [hecho(ID_PRECIO, 'precio', 'el café cuesta 4 dólares'), hecho(ID_HORARIO, 'horario', 'abrimos de lunes a viernes')];

function entrada(texto: string, extra: Partial<EntradaTextoLocucion> = {}): EntradaTextoLocucion {
  return { texto, modelo: texto, hechos: HECHOS, reglas: [], ahora: AHORA, instantePieza: PIEZA, ...extra };
}

function fallo(e: EntradaTextoLocucion): LocucionTextoInvalidoError {
  try {
    prepararTextoLocucion(e);
  } catch (error) {
    expect(error).toBeInstanceOf(LocucionTextoInvalidoError);
    return error as LocucionTextoInvalidoError;
  }
  throw new Error('expected a refusal');
}

describe('normalizarTextoLocucion', () => {
  it('is NFC, collapses whitespace and trims', () => {
    expect(normalizarTextoLocucion('  Café   fresco \n hoy  ')).toBe('Café fresco hoy');
    expect(normalizarTextoLocucion('Café')).toBe(normalizarTextoLocucion('Café'));
  });
});

describe('prepararTextoLocucion', () => {
  it('gives null (no voice) for an empty text or only spaces', () => {
    for (const vacio of ['', '   ', '\n\t ']) expect(prepararTextoLocucion(entrada(vacio))).toBeNull();
  });

  it('returns the prepared text and its character count (code points)', () => {
    const r = prepararTextoLocucion(entrada('  Prueba el café de la casa  '));
    expect(r).toEqual({ texto: 'Prueba el café de la casa', caracteres: 25 });
    expect(prepararTextoLocucion(entrada('Hola 😀'))!.caracteres).toBe(6);
  });

  it('accepts a figure that comes from a cited verified fact (rule 2)', () => {
    const modelo = `Ven hoy, {{hecho:${ID_PRECIO}}} y te esperamos`;
    const texto = 'Ven hoy, el café cuesta 4 dólares y te esperamos';
    expect(prepararTextoLocucion(entrada(texto, { modelo }))!.texto).toBe(texto);
  });

  it('refuses a free figure, price, schedule or promotion not backed by a cited fact', () => {
    expect(fallo(entrada('Solo cuesta 4 dólares')).reason).toBe('cifra_libre');
    expect(fallo(entrada('Abrimos a las 8:00')).reason).toBe('cifra_libre');
    expect(fallo(entrada('Tenemos 20% de descuento')).reason).toBe('cifra_libre');
    // A figure next to a cited fact is still free.
    const modelo = `Ven, {{hecho:${ID_PRECIO}}} y ademas 2x1`;
    expect(fallo(entrada('Ven, el café cuesta 4 dólares y ademas 2x1', { modelo })).reason).toBe('cifra_libre');
  });

  it('refuses a fact that is not valid now or at the piece instant, and a fact text that was edited', () => {
    const modelo = `Ven, {{hecho:${ID_PRECIO}}}`;
    const vencido = [hecho(ID_PRECIO, 'precio', 'el café cuesta 4 dólares', { vigente_hasta: new Date('2026-11-03T00:00:00Z') })];
    expect(fallo(entrada('Ven, el café cuesta 4 dólares', { modelo, hechos: vencido })).motivos).toContain('hecho_no_vigente');
    expect(fallo(entrada('Ven, el café cuesta 5 dólares', { modelo })).motivos).toContain('hecho_texto_cambiado');
  });

  it('refuses banned words, promises and topics, accent and case insensitive', () => {
    const reglas = [
      { tipo: 'palabra', texto: 'Barato' },
      { tipo: 'promesa', texto: 'el mejor del mundo' },
      { tipo: 'tema', texto: 'política' },
    ] as const;
    expect(fallo(entrada('Es BARATO y rico', { reglas })).reason).toBe('regla_prohibida_palabra');
    expect(fallo(entrada('Somos el MEJOR del mundo', { reglas })).reason).toBe('regla_prohibida_promesa');
    expect(fallo(entrada('Hablemos de politica', { reglas })).reason).toBe('regla_prohibida_tema');
    expect(fallo(entrada('Barato y de politica', { reglas })).motivos).toEqual(['regla_prohibida_palabra', 'regla_prohibida_tema']);
    // A whole-word rule does not fire inside another word.
    expect(prepararTextoLocucion(entrada('Es baratisimo en sabor', { reglas: [{ tipo: 'palabra', texto: 'barato' }] }))).not.toBeNull();
    // A visual rule never matches text.
    expect(prepararTextoLocucion(entrada('Un perro', { reglas: [{ tipo: 'elemento_visual', texto: 'perro' }] }))).not.toBeNull();
  });

  it('refuses an unreplaced or malformed fact token', () => {
    expect(fallo(entrada(`Ven hoy {{hecho:${ID_PRECIO}}}`)).reason).toBe('token_sin_reemplazar');
    expect(fallo(entrada('Ven {{hecho:roto')).reason).toBe('token_sin_reemplazar');
  });

  it('refuses a text longer than the house limit, counting code points', () => {
    expect(prepararTextoLocucion(entrada('a'.repeat(300)))!.caracteres).toBe(300);
    expect(fallo(entrada('a'.repeat(301))).reason).toBe('demasiado_largo');
    expect(prepararTextoLocucion(entrada('😀'.repeat(300)))!.caracteres).toBe(300);
  });

  it('refuses a request for AI-generated imagery but lets a client talk about AI', () => {
    expect(fallo(entrada('Imágenes generadas con IA de tu café')).reason).toBe('pide_imagen_ia');
    expect(prepararTextoLocucion(entrada('Nuestra IA te ayuda a elegir'))).not.toBeNull();
  });

  it('lists every reason in a fixed order', () => {
    const e = fallo(entrada(`Sin cerrar {{hecho:x, cuesta 4 dolares, barato`, { reglas: [{ tipo: 'palabra', texto: 'barato' }] }));
    expect(e.motivos).toEqual(['token_sin_reemplazar', 'cifra_libre', 'regla_prohibida_palabra']);
    expect(e.reason).toBe('token_sin_reemplazar');
  });
});
