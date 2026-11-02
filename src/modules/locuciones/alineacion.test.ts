import { describe, expect, it } from 'vitest';
import { calcularTiemposPalabras, type TiempoPalabra } from '../produccion/tiemposPalabras.js';
import { alineacionAPalabras, alineacionDesdeSegundos, type AlineacionCaracteres } from './alineacion.js';
import { AlineacionInvalidaError } from './errors.js';

/** An alignment where every character lasts `paso` ms, one after another. */
function uniforme(texto: string, paso = 100, inicio = 0): AlineacionCaracteres {
  const caracteres = [...texto];
  return { caracteres, inicioMs: caracteres.map((_c, i) => inicio + i * paso), finMs: caracteres.map((_c, i) => inicio + (i + 1) * paso) };
}

function sin(a: AlineacionCaracteres, indice: number): AlineacionCaracteres {
  const quita = <T>(l: readonly T[]) => l.filter((_x, i) => i !== indice);
  return { caracteres: quita(a.caracteres), inicioMs: quita(a.inicioMs), finMs: quita(a.finMs) };
}

function razon(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AlineacionInvalidaError);
    return (error as AlineacionInvalidaError).reason;
  }
  throw new Error('expected a refusal');
}

describe('alineacionAPalabras', () => {
  it('gives the shape of calcularTiemposPalabras: contiguous words, the last one holds until the end of the scene', () => {
    const r = alineacionAPalabras(uniforme('Hola mundo'), 'Hola mundo', 5000);
    expect(r).toEqual<TiempoPalabra[]>([
      { palabra: 'Hola', inicioMs: 0, finMs: 500 },
      { palabra: 'mundo', inicioMs: 500, finMs: 5000 },
    ]);
    const calculado = calcularTiemposPalabras('Hola mundo', 5000);
    expect(Object.keys(r[0]!)).toEqual(Object.keys(calculado[0]!));
  });

  it('shifts the times by the lead-in of the voice inside the scene', () => {
    const r = alineacionAPalabras(uniforme('Uno dos'), 'Uno dos', 4000, 150);
    expect(r.map((p) => p.inicioMs)).toEqual([150, 550]);
  });

  it('keeps punctuation attached to its word', () => {
    const r = alineacionAPalabras(uniforme('¡Hola, mundo! ¿Qué tal?'), '¡Hola, mundo! ¿Qué tal?', 9000);
    expect(r.map((p) => p.palabra)).toEqual(['¡Hola,', 'mundo!', '¿Qué', 'tal?']);
  });

  it('keeps numbers as they are in the text and times them like any word', () => {
    const r = alineacionAPalabras(uniforme('Solo 4 dólares'), 'Solo 4 dólares', 6000);
    expect(r.map((p) => p.palabra)).toEqual(['Solo', '4', 'dólares']);
    expect(r[1]).toMatchObject({ inicioMs: 500, finMs: 700 });
  });

  it('counts an accent as one character: NFC and NFD give the same result', () => {
    const texto = 'Café con piña';
    const nfc = alineacionAPalabras(uniforme(texto.normalize('NFC')), texto, 6000);
    // NFD alignment: each combining mark is its own entry with its own time.
    const nfdCaracteres = [...texto.normalize('NFD')];
    const nfd: AlineacionCaracteres = {
      caracteres: nfdCaracteres,
      inicioMs: nfdCaracteres.map((_c, i) => i * 100),
      finMs: nfdCaracteres.map((_c, i) => (i + 1) * 100),
    };
    const resultadoNfd = alineacionAPalabras(nfd, texto.normalize('NFD'), 6000);
    expect(resultadoNfd.map((p) => p.palabra)).toEqual(nfc.map((p) => p.palabra));
    // The words start at the same character; only the timing of what follows an accent shifts by the extra entries.
    expect(resultadoNfd[0]).toMatchObject({ palabra: 'Café', inicioMs: 0 });
    // Same text, same alignment entries (NFD text against the NFD alignment) vs the NFC text: identical.
    expect(alineacionAPalabras(nfd, texto.normalize('NFC'), 6000)).toEqual(resultadoNfd);
    // And an NFC alignment against an NFD text.
    expect(alineacionAPalabras(uniforme(texto.normalize('NFC')), texto.normalize('NFD'), 6000)).toEqual(nfc);
  });

  it('interpolates ONE missing character inside a word', () => {
    const texto = 'Hola mundo';
    const a = sin(uniforme(texto), 2); // the first "l" is missing
    const r = alineacionAPalabras(a, texto, 5000);
    expect(r.map((p) => p.palabra)).toEqual(['Hola', 'mundo']);
    expect(r[0]!.inicioMs).toBe(0);
    expect(r[1]!.inicioMs).toBe(500); // the other characters keep their own times
  });

  it('interpolates a missing first character of a word with its neighbour', () => {
    const texto = 'Hola mundo';
    const a = sin(uniforme(texto), 5); // the "m" is missing
    const r = alineacionAPalabras(a, texto, 5000);
    expect(r[1]).toMatchObject({ palabra: 'mundo' });
    // It takes the end of the character before it (the space), so the word starts there.
    expect(r[1]!.inicioMs).toBe(500);
  });

  it('interpolates a missing last character of the text', () => {
    const texto = 'Hola mundo';
    const a = sin(uniforme(texto), 9);
    expect(alineacionAPalabras(a, texto, 5000).map((p) => p.palabra)).toEqual(['Hola', 'mundo']);
  });

  it('refuses a word with no timed character at all', () => {
    const texto = 'Hola y mundo';
    expect(razon(() => alineacionAPalabras(sin(uniforme(texto), 5), texto, 5000))).toBe('palabra_sin_tiempos');
  });

  it('refuses a missing space, two missing characters in a row, an extra character and different text', () => {
    const texto = 'Hola mundo';
    expect(razon(() => alineacionAPalabras(sin(uniforme(texto), 4), texto, 5000))).toBe('no_coincide_con_el_texto');
    expect(razon(() => alineacionAPalabras(sin(sin(uniforme(texto), 6), 6), texto, 5000))).toBe('no_coincide_con_el_texto');
    expect(razon(() => alineacionAPalabras(uniforme('Hola mundoo'), texto, 5000))).toBe('no_coincide_con_el_texto');
    expect(razon(() => alineacionAPalabras(uniforme('Adios mundo'), texto, 5000))).toBe('no_coincide_con_el_texto');
  });

  it('refuses malformed alignments (lengths, values, order) with a reason only', () => {
    const texto = 'Hola';
    const ok = uniforme(texto);
    expect(razon(() => alineacionAPalabras({ ...ok, finMs: ok.finMs.slice(1) }, texto, 5000))).toBe('longitudes_distintas');
    expect(razon(() => alineacionAPalabras({ ...ok, inicioMs: [0, 1.5, 2, 3] }, texto, 5000))).toBe('valor_invalido');
    expect(razon(() => alineacionAPalabras({ ...ok, inicioMs: [0, -1, 2, 3] }, texto, 5000))).toBe('valor_invalido');
    expect(razon(() => alineacionAPalabras({ ...ok, inicioMs: [0, 200, 100, 300] }, texto, 5000))).toBe('tiempos_no_crecientes');
    expect(razon(() => alineacionAPalabras({ ...ok, finMs: [50, 40, 300, 400] }, texto, 5000))).toBe('tiempos_no_crecientes');
    expect(razon(() => alineacionAPalabras(ok, texto, 0))).toBe('valor_invalido');
  });

  it('keeps every word at least 1 ms when two start together', () => {
    const a: AlineacionCaracteres = { caracteres: [...'a b'], inicioMs: [0, 0, 0], finMs: [0, 0, 0] };
    expect(alineacionAPalabras(a, 'a b', 1000).map((p) => [p.inicioMs, p.finMs])).toEqual([
      [0, 1],
      [1, 1000],
    ]);
  });

  it('refuses a voice that starts at or after the end of the scene', () => {
    expect(razon(() => alineacionAPalabras(uniforme('Hola mundo'), 'Hola mundo', 450))).toBe('fuera_de_la_escena');
  });

  it('treats other whitespace as a space and handles emoji as one character', () => {
    const r = alineacionAPalabras(uniforme('Hola 😀 mundo'), 'Hola 😀 mundo', 8000);
    expect(r.map((p) => p.palabra)).toEqual(['Hola', '😀', 'mundo']);
    expect(alineacionAPalabras(uniforme('Hola mundo'), 'Hola mundo', 5000).map((p) => p.palabra)).toEqual(['Hola', 'mundo']);
  });

  it('works for a single word and for an empty text', () => {
    expect(alineacionAPalabras(uniforme('Hola'), 'Hola', 2000)).toEqual([{ palabra: 'Hola', inicioMs: 0, finMs: 2000 }]);
    expect(alineacionAPalabras({ caracteres: [], inicioMs: [], finMs: [] }, '', 2000)).toEqual([]);
  });
});

describe('alineacionDesdeSegundos', () => {
  it('rounds seconds to whole milliseconds', () => {
    const r = alineacionDesdeSegundos({ characters: ['a', 'b'], character_start_times_seconds: [0, 0.1234], character_end_times_seconds: [0.1234, 0.2006] });
    expect(r).toEqual({ caracteres: ['a', 'b'], inicioMs: [0, 123], finMs: [123, 201] });
  });

  it('refuses different lengths and bad numbers', () => {
    expect(razon(() => alineacionDesdeSegundos({ characters: ['a'], character_start_times_seconds: [], character_end_times_seconds: [1] }))).toBe('longitudes_distintas');
    expect(razon(() => alineacionDesdeSegundos({ characters: ['a'], character_start_times_seconds: [Number.NaN], character_end_times_seconds: [1] }))).toBe('valor_invalido');
    expect(razon(() => alineacionDesdeSegundos({ characters: ['a'], character_start_times_seconds: [-0.1], character_end_times_seconds: [1] }))).toBe('valor_invalido');
  });
});
