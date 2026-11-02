import { describe, expect, it } from 'vitest';
import { alineacionAPalabras, alineacionDesdeSegundos } from './alineacion.js';
import { claveCache } from './claveCache.js';
import { comprobarAjusteEscena, comprobarAjusteReel } from './ajuste.js';
import { prepararTextoLocucion } from './textoLocucion.js';

// Property: whatever the text, no error of the voice code carries it (message, name, reasons or fields).
// Seeded generator, so a failure repeats.

function generador(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const ALFABETO = 'abcdefghijklmnñopqrstuvwxyzáéíóúü ABCDEFGHIJ0123456789.,;:!?¿¡{}-😀';

function textoAleatorio(rnd: () => number): string {
  const largo = 3 + Math.floor(rnd() * 40);
  let t = 'zq'; // a marker that never appears in a reason or a message
  for (let i = 0; i < largo; i++) t += ALFABETO[Math.floor(rnd() * ALFABETO.length)];
  return `${t}xk`;
}

function capturar(run: () => unknown): Error | null {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  return null;
}

function volcado(error: Error): string {
  const campos: Record<string, unknown> = {};
  for (const clave of Object.getOwnPropertyNames(error)) campos[clave] = (error as unknown as Record<string, unknown>)[clave];
  return JSON.stringify(campos) + error.message + error.name + String(error.stack ?? '').split('\n')[0];
}

describe('no client text reaches an error', () => {
  it('for texts that fail the text preparation (cifras, banned rules, tokens, length)', () => {
    const rnd = generador(7);
    let errores = 0;
    for (let i = 0; i < 300; i++) {
      const base = textoAleatorio(rnd);
      const variantes = [`${base} cuesta 5 dólares`, `${base} {{hecho:roto`, `${base} barato`, base + 'a'.repeat(300)];
      for (const texto of variantes) {
        const error = capturar(() =>
          prepararTextoLocucion({ texto, modelo: texto, hechos: [], reglas: [{ tipo: 'palabra', texto: 'barato' }], ahora: new Date(), instantePieza: new Date() }),
        );
        if (!error) continue;
        errores++;
        expect(volcado(error)).not.toContain(base.slice(0, 12));
        expect(volcado(error)).not.toContain(texto.slice(2, 12));
      }
    }
    expect(errores).toBeGreaterThan(300);
  });

  it('for alignments that do not match the text', () => {
    const rnd = generador(11);
    let errores = 0;
    for (let i = 0; i < 300; i++) {
      const texto = textoAleatorio(rnd);
      const otro = textoAleatorio(rnd);
      const caracteres = [...otro];
      const a = { caracteres, inicioMs: caracteres.map((_c, k) => k * 10), finMs: caracteres.map((_c, k) => k * 10 + 10) };
      const error = capturar(() => alineacionAPalabras(a, texto, 100_000));
      if (!error) continue;
      errores++;
      expect(volcado(error)).not.toContain(texto.slice(2, 12));
      expect(volcado(error)).not.toContain(otro.slice(2, 12));
    }
    expect(errores).toBeGreaterThan(250);
    const mala = capturar(() => alineacionDesdeSegundos({ characters: ['zqsecretoxk'], character_start_times_seconds: [Number.NaN], character_end_times_seconds: [1] }));
    expect(mala).not.toBeNull();
    expect(volcado(mala!)).not.toContain('secreto');
  });

  it('for cache keys and fit checks fed with text in the wrong place', () => {
    const rnd = generador(13);
    for (let i = 0; i < 100; i++) {
      const texto = textoAleatorio(rnd);
      const ajustes = { estabilidad: 5, similitud: 0.5, estilo: 0, velocidad: 1, refuerzoVoz: true, idioma: 'es' };
      const e1 = capturar(() => claveCache({ texto, vozId: 'v', modeloId: 'm', formato: 'f', ajustes }));
      expect(e1).not.toBeNull();
      expect(volcado(e1!)).not.toContain(texto.slice(2, 12));
      const e2 = capturar(() => claveCache({ texto: 'ok\ud800' + texto, vozId: 'v', modeloId: 'm', formato: 'f', ajustes: { ...ajustes, estabilidad: 0.5 } }));
      expect(e2).not.toBeNull();
      expect(volcado(e2!)).not.toContain(texto.slice(2, 12));
      const e3 = capturar(() => comprobarAjusteEscena({ escena: 1, duracionVozMs: texto as never, duracionEscenaMs: 1000 }));
      expect(volcado(e3!)).not.toContain(texto.slice(2, 12));
      const e4 = capturar(() => comprobarAjusteReel([{ escena: 1, duracionS: texto as never, duracionVozMs: null }]));
      expect(volcado(e4!)).not.toContain(texto.slice(2, 12));
    }
  });
});
