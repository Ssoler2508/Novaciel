import { describe, expect, it } from 'vitest';
import { checksFuentes, type EntradaFuentes } from './fuentes.js';
import type { CheckQC } from './tipos.js';

const M1 = '0a000000-0000-4000-8000-000000000001';
const M2 = '0a000000-0000-4000-8000-000000000002';
const AJENA = '0b000000-0000-4000-8000-0000000000ff';

const base: EntradaFuentes = {
  tomas: [
    { orden: 1, fuente: 'media_real', mediaId: M1 },
    { orden: 2, fuente: 'media_real', mediaId: M2 },
  ],
  archivos: [
    { orden: 1, mediaId: M1 },
    { orden: 2, mediaId: M2 },
  ],
  fuentesReel: [],
  biblioteca: new Set([M1, M2]),
};
const por = (checks: CheckQC[], codigo: string) => checks.find((c) => c.codigo === codigo)!;
const estado = (e: EntradaFuentes) => Object.fromEntries(checksFuentes(e).map((c) => [c.codigo, c.resultado]));

describe('checksFuentes', () => {
  it('returns the two codes, both passing when everything is real media of the library', () => {
    expect(checksFuentes(base).map((c) => [c.codigo, c.resultado])).toEqual([
      ['fuente_ia_no_permitida', 'pasa'],
      ['toma_faltante', 'pasa'],
    ]);
  });

  it('passes a reel whose clips are all in the library', () => {
    expect(estado({ ...base, fuentesReel: [{ ordenArchivo: 1, escena: 1, mediaId: M1 }, { ordenArchivo: 1, escena: 2, mediaId: M2 }] })).toEqual({ fuente_ia_no_permitida: 'pasa', toma_faltante: 'pasa' });
  });

  it('generacion_ia fails fuente_ia_no_permitida and not toma_faltante', () => {
    const checks = checksFuentes({ ...base, tomas: [base.tomas[0]!, { orden: 2, fuente: 'generacion_ia', mediaId: null }] });
    expect(por(checks, 'fuente_ia_no_permitida')).toMatchObject({ resultado: 'no_pasa', parametros: { tomas: [2], fuentes: ['generacion_ia'] } });
    expect(por(checks, 'toma_faltante').resultado).toBe('pasa');
  });

  it('animacion_ia fails fuente_ia_no_permitida', () => {
    const checks = checksFuentes({ ...base, tomas: [{ orden: 1, fuente: 'animacion_ia', mediaId: null }, base.tomas[1]!] });
    expect(por(checks, 'fuente_ia_no_permitida')).toMatchObject({ resultado: 'no_pasa', parametros: { tomas: [1], fuentes: ['animacion_ia'] } });
    expect(por(checks, 'toma_faltante').resultado).toBe('pasa');
  });

  it('an unknown fuente fails fuente_ia_no_permitida and is reported as "desconocida", never as the raw value', () => {
    const checks = checksFuentes({ ...base, tomas: [{ orden: 1, fuente: 'Stock Fotos Privadas', mediaId: null }, base.tomas[1]!] });
    expect(por(checks, 'fuente_ia_no_permitida')).toMatchObject({ resultado: 'no_pasa', parametros: { tomas: [1], fuentes: ['desconocida'] } });
    expect(JSON.stringify(checks)).not.toContain('Stock');
    expect(por(checks, 'toma_faltante').resultado).toBe('pasa');
  });

  it('a final file made from media outside the client library fails fuente_ia_no_permitida', () => {
    const checks = checksFuentes({ ...base, archivos: [{ orden: 1, mediaId: M1 }, { orden: 2, mediaId: AJENA }] });
    expect(por(checks, 'fuente_ia_no_permitida')).toMatchObject({ resultado: 'no_pasa', parametros: { archivos: [2], tomas: [], clips: [] } });
    expect(por(checks, 'toma_faltante').resultado).toBe('pasa');
  });

  it('a reel clip outside the client library fails fuente_ia_no_permitida, naming file and scene', () => {
    const checks = checksFuentes({ ...base, fuentesReel: [{ ordenArchivo: 1, escena: 1, mediaId: M1 }, { ordenArchivo: 1, escena: 3, mediaId: AJENA }] });
    expect(por(checks, 'fuente_ia_no_permitida')).toMatchObject({ resultado: 'no_pasa', parametros: { clips: ['1:3'] } });
  });

  it('a missing scene (faltante) fails toma_faltante and does NOT fail fuente_ia_no_permitida', () => {
    const checks = checksFuentes({ ...base, tomas: [base.tomas[0]!, { orden: 2, fuente: 'faltante', mediaId: null }] });
    expect(por(checks, 'toma_faltante')).toMatchObject({ resultado: 'no_pasa', severidad: 'bloqueante', motivo: 'Hay una toma sin media real.', parametros: { tomas: [2] } });
    expect(por(checks, 'fuente_ia_no_permitida').resultado).toBe('pasa');
  });

  it('both can fail at once, each for its own reason', () => {
    const checks = checksFuentes({
      ...base,
      tomas: [{ orden: 1, fuente: 'faltante', mediaId: null }, { orden: 2, fuente: 'generacion_ia', mediaId: null }],
    });
    expect(Object.fromEntries(checks.map((c) => [c.codigo, c.resultado]))).toEqual({ fuente_ia_no_permitida: 'no_pasa', toma_faltante: 'no_pasa' });
  });

  it('an empty library fails every file, so a client can never use media that is not in its own library', () => {
    expect(estado({ ...base, biblioteca: new Set() }).fuente_ia_no_permitida).toBe('no_pasa');
  });
});
