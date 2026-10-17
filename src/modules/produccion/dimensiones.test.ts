import { describe, expect, it } from 'vitest';
import { FORMATOS, FORMATOS_POR_RED, REDES } from '../planificador/types.js';
import { DimensionNoSoportadaError, DIMENSIONES, dimensionDe } from './dimensiones.js';

describe('dimensionDe', () => {
  it('has a size, a source and a verify flag for every format each network takes', () => {
    for (const red of REDES) {
      for (const formato of FORMATOS_POR_RED[red]) {
        const dimension = dimensionDe(red, formato);
        expect(dimension.ancho, `${red} ${formato}`).toBeGreaterThan(0);
        expect(dimension.alto, `${red} ${formato}`).toBeGreaterThan(0);
        expect(dimension.fuente.length).toBeGreaterThan(0);
        expect(typeof dimension.verificar).toBe('boolean');
      }
    }
  });

  it('gives the sizes of the table', () => {
    expect(dimensionDe('instagram', 'carrusel')).toMatchObject({ ancho: 1080, alto: 1350, verificar: true });
    expect(dimensionDe('facebook', 'post')).toMatchObject({ ancho: 1080, alto: 1350, verificar: true });
    expect(dimensionDe('instagram', 'historia')).toMatchObject({ ancho: 1080, alto: 1920 });
    // The only value the spec gives (9.4, vertical 1080 x 1920) is not marked VERIFY.
    for (const red of REDES) expect(dimensionDe(red, 'reel')).toMatchObject({ ancho: 1080, alto: 1920, verificar: false });
  });

  it('refuses a format the network does not take', () => {
    for (const red of ['tiktok', 'youtube'] as const) {
      for (const formato of FORMATOS.filter((f) => f !== 'reel')) {
        expect(() => dimensionDe(red, formato), `${red} ${formato}`).toThrow(DimensionNoSoportadaError);
      }
    }
    expect(() => dimensionDe('myspace' as never, 'reel')).toThrow(DimensionNoSoportadaError);
  });

  it('marks every house value that is not in the spec as VERIFY', () => {
    for (const por of Object.values(DIMENSIONES)) {
      for (const dimension of Object.values(por)) {
        if (!dimension.fuente.startsWith('spec 9.4 (vertical 1080 x 1920)') || dimension.fuente.includes('still stories')) {
          expect(dimension.verificar, dimension.fuente).toBe(true);
        }
      }
    }
  });

  it('keeps the dimensions of a carousel in a 4:5 ratio', () => {
    const { ancho, alto } = dimensionDe('instagram', 'carrusel');
    expect(ancho / alto).toBeCloseTo(4 / 5);
  });
});
