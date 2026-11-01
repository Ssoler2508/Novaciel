import { describe, expect, it } from 'vitest';
import { CATALOGO, CODIGOS_QC, type CodigoQC } from './catalogo.js';
import { crearCheck, ParametroInseguroError } from './crearCheck.js';
import { codigosDeFallo, decidirResultadoQC } from './decision.js';

describe('the catalogue', () => {
  it('has one entry per code, no repeats, and every code is a stable snake_case identifier the database accepts', () => {
    expect(Object.keys(CATALOGO).sort()).toEqual([...CODIGOS_QC].sort());
    expect(new Set(CODIGOS_QC).size).toBe(CODIGOS_QC.length);
    for (const codigo of CODIGOS_QC) expect(codigo, codigo).toMatch(/^[a-z0-9_]{1,60}$/);
  });

  it('gives every code a short reason in Spanish and a severity, and only two codes are warnings', () => {
    for (const codigo of CODIGOS_QC) {
      const { severidad, motivo } = CATALOGO[codigo];
      expect(['bloqueante', 'advertencia'], codigo).toContain(severidad);
      expect(motivo.length, codigo).toBeGreaterThan(10);
      expect(motivo.length, codigo).toBeLessThanOrEqual(120);
      expect(motivo.endsWith('.'), codigo).toBe(true);
    }
    expect(CODIGOS_QC.filter((c) => CATALOGO[c].severidad === 'advertencia').sort()).toEqual(['marca_colores_respaldo', 'programacion_proxima']);
  });

  it('has the agreed reason for a scene without real media', () => {
    expect(CATALOGO.toma_faltante).toEqual({ severidad: 'bloqueante', motivo: 'Hay una toma sin media real.' });
  });

  it('does not compile with a code outside the list (compile-time check, enforced by npm run typecheck)', () => {
    // @ts-expect-error a code that is not in CODIGOS_QC is not accepted
    const desconocido: CodigoQC = 'codigo_inventado';
    // @ts-expect-error a catalogue that misses a code is not a Record<CodigoQC, ...>
    const incompleto: Record<CodigoQC, unknown> = { cifra_libre: {} };
    expect([desconocido, incompleto]).toBeDefined();
  });
});

describe('crearCheck', () => {
  it('passes with "Cumple.", fails blocking codes as no_pasa and warning codes as advertencia', () => {
    expect(crearCheck('hashtags_cantidad', true, { cantidad: 3 })).toEqual({
      codigo: 'hashtags_cantidad',
      resultado: 'pasa',
      severidad: 'bloqueante',
      motivo: 'Cumple.',
      parametros: { cantidad: 3 },
    });
    expect(crearCheck('hashtags_cantidad', false)).toMatchObject({ resultado: 'no_pasa', severidad: 'bloqueante', motivo: CATALOGO.hashtags_cantidad.motivo });
    expect(crearCheck('programacion_proxima', false)).toMatchObject({ resultado: 'advertencia', severidad: 'advertencia', motivo: CATALOGO.programacion_proxima.motivo });
  });

  it('accepts numbers, booleans and closed identifiers (positions, field ids, uuids)', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(() => crearCheck('cifra_libre', false, { campos: ['hashtag:2', 'texto_publicacion:0'], hecho_id: uuid, minutos: -4, ok: true, vacio: [] })).not.toThrow();
  });

  it.each([
    ['a sentence', 'Probá nuestro café'],
    ['a capitalised word', 'Gratis'],
    ['an accented word', 'café'],
    ['an empty string', ''],
    ['a long identifier', 'a'.repeat(81)],
    ['a nested object', { texto: 'x' }],
    ['a list with a sentence', ['ok', 'dos palabras']],
    ['a number that is not finite', Number.NaN],
    ['null', null],
  ])('refuses %s as a parameter, without echoing it', (_nombre, valor) => {
    let error: unknown;
    try {
      crearCheck('cifra_libre', false, { dato: valor } as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ParametroInseguroError);
    expect((error as Error).message).toBe('Unsafe quality-control parameter: dato');
  });
});

describe('decidirResultadoQC and codigosDeFallo', () => {
  const pasa = crearCheck('hashtags_cantidad', true);
  const falla = crearCheck('hashtags_forma', false);
  const aviso = crearCheck('programacion_proxima', false);

  it('rejects when a blocking check did not pass, and lists the failed codes', () => {
    expect(decidirResultadoQC([pasa, falla])).toBe('rechazado');
    expect(codigosDeFallo([pasa, falla, crearCheck('cifra_libre', false)])).toEqual(['hashtags_forma', 'cifra_libre']);
  });

  it('approves when everything passes, and a warning alone does not reject', () => {
    expect(decidirResultadoQC([pasa])).toBe('aprobado');
    expect(decidirResultadoQC([pasa, aviso])).toBe('aprobado');
    expect(codigosDeFallo([pasa, aviso])).toEqual([]);
  });

  it('refuses an empty list: a run without checks is a bug, and the database needs at least one', () => {
    expect(() => decidirResultadoQC([])).toThrow(/at least one check/);
  });
});
