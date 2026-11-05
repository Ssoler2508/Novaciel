import { describe, expect, it } from 'vitest';
import { claveIdempotencia } from './claveIdempotencia.js';
import { normalizarMetricasFake } from './normalizarMetricas.js';
import { siguienteHorarioPermitido, validarProgramacion } from './reglasProgramacion.js';
import { decidirReintento } from './politicaReintentos.js';

// Property: whatever the client text, no error of the pure publishing code carries it (message, name,
// reasons or fields). Seeded generator, so a failure repeats.

function generador(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const ALFABETO = 'abcdefghijklmnñopqrstuvwxyzáéíóúü ABCDEFGHIJ0123456789.,;:!?¿¡{}-/😀';

function textoAleatorio(rnd: () => number): string {
  const largo = 6 + Math.floor(rnd() * 40);
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
  it('for ids and hashes that are not valid', () => {
    const rnd = generador(5);
    let errores = 0;
    for (let i = 0; i < 300; i++) {
      const texto = textoAleatorio(rnd);
      const validoId = '11111111-1111-4111-8111-111111111111';
      const casos: (() => unknown)[] = [
        () => claveIdempotencia({ piezaId: texto, produccionId: validoId, hashPieza: new Uint8Array(32) }),
        () => claveIdempotencia({ piezaId: validoId, produccionId: texto, hashPieza: new Uint8Array(32) }),
        () => claveIdempotencia({ piezaId: validoId, produccionId: validoId, hashPieza: texto as unknown as Uint8Array }),
      ];
      for (const caso of casos) {
        const error = capturar(caso);
        expect(error).not.toBeNull();
        errores++;
        expect(volcado(error!)).not.toContain(texto.slice(0, 14));
      }
    }
    expect(errores).toBe(900);
  });

  it('for raw metrics that are not an object', () => {
    const rnd = generador(9);
    for (let i = 0; i < 300; i++) {
      const texto = textoAleatorio(rnd);
      const error = capturar(() => normalizarMetricasFake(texto));
      expect(error).not.toBeNull();
      expect(volcado(error!)).not.toContain(texto.slice(0, 14));
    }
  });

  it('for a zone that is not valid and for a schedule that cannot be satisfied', () => {
    const rnd = generador(13);
    for (let i = 0; i < 300; i++) {
      const texto = textoAleatorio(rnd);
      const ahora = new Date('2026-06-10T12:00:00Z');
      const e1 = capturar(() => validarProgramacion({ fechaHora: ahora, ahora, zona: texto, horariosVetados: [] }));
      const e2 = capturar(() => siguienteHorarioPermitido({ desde: ahora, zona: texto, horariosVetados: [] }));
      for (const error of [e1, e2]) {
        expect(error).not.toBeNull();
        expect(volcado(error!)).not.toContain(texto.slice(0, 14));
      }
    }
    const sinHueco = capturar(() => siguienteHorarioPermitido({ desde: new Date('2026-06-10T12:00:00Z'), zona: 'America/New_York', horariosVetados: [{ desde: '00:00', hasta: '23:59' }] }));
    expect(sinHueco).not.toBeNull();
    expect(volcado(sinHueco!)).toMatch(/14/);
  });

  it('for bad retry arguments, and a valid decision carries no free text', () => {
    const rnd = generador(17);
    for (let i = 0; i < 100; i++) {
      const texto = textoAleatorio(rnd);
      const error = capturar(() => decidirReintento({ categoria: 'server', intentosHechos: texto as unknown as number, azar: 0.5 }));
      expect(error).not.toBeNull();
      expect(volcado(error!)).not.toContain(texto.slice(0, 14));
    }
    const decision = decidirReintento({ categoria: 'auth', intentosHechos: 1, azar: 0.5 });
    expect(Object.values(decision).every((v) => typeof v === 'string')).toBe(true);
  });
});
