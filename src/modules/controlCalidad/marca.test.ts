import { describe, expect, it } from 'vitest';
import { FUENTE_POR_DEFECTO } from '../produccion/fonts.js';
import { checkContraste, checksMarca, FUENTES_PERMITIDAS, type EntradaMarca } from './marca.js';
import type { CheckQC } from './tipos.js';

const PERFIL_V1 = '9a3c1a50-0000-4000-8000-000000000001';
const PERFIL_V2 = '9a3c1a50-0000-4000-8000-000000000002';

const KIT_MARCA = { colores: { principal: '#1b1b3a', secundarios: ['#fdf6e3'], acento: '#ff9f1c' } };
const KIT_SIN_COLORES = { colores: {} };

const base: EntradaMarca = { perfilMarcaId: PERFIL_V1, kitVisualDelBrief: KIT_MARCA, fuenteRender: 'Inter', textosEnPantalla: ['Hola', 'Café del día'] };
const por = (checks: CheckQC[], codigo: string) => checks.find((c) => c.codigo === codigo)!;
const estado = (e: EntradaMarca) => Object.fromEntries(checksMarca(e).map((c) => [c.codigo, c.resultado]));

describe('checksMarca', () => {
  it('returns the four brand codes, all passing for a profile with brand colours', () => {
    expect(estado(base)).toEqual({
      marca_contraste: 'pasa',
      marca_colores_respaldo: 'pasa',
      marca_fuente_no_permitida: 'pasa',
      marca_glifos_no_soportados: 'pasa',
    });
  });

  it('records the profile version the brief used in every colour and font check', () => {
    for (const check of checksMarca(base).filter((c) => c.codigo !== 'marca_glifos_no_soportados')) expect(check.parametros.perfil_marca_id, check.codigo).toBe(PERFIL_V1);
  });

  it('judges the kit it is given: the profile version of the brief, not whatever is current', () => {
    // Version 1 (the brief's) has brand colours; a later version 2 lost them. The caller passes version 1.
    const delBrief = checksMarca({ ...base, perfilMarcaId: PERFIL_V1, kitVisualDelBrief: KIT_MARCA });
    const posterior = checksMarca({ ...base, perfilMarcaId: PERFIL_V2, kitVisualDelBrief: KIT_SIN_COLORES });
    expect(por(delBrief, 'marca_colores_respaldo').resultado).toBe('pasa');
    expect(por(posterior, 'marca_colores_respaldo')).toMatchObject({ resultado: 'advertencia', parametros: { perfil_marca_id: PERFIL_V2 } });
  });

  it('warns, without rejecting, when the profile has no usable colours and the fallback was used', () => {
    const check = por(checksMarca({ ...base, kitVisualDelBrief: KIT_SIN_COLORES }), 'marca_colores_respaldo');
    expect(check).toMatchObject({ resultado: 'advertencia', severidad: 'advertencia' });
    // Even then the colours really chosen pass the contrast rule.
    expect(por(checksMarca({ ...base, kitVisualDelBrief: KIT_SIN_COLORES }), 'marca_contraste').resultado).toBe('pasa');
    expect(por(checksMarca({ ...base, kitVisualDelBrief: undefined }), 'marca_colores_respaldo').resultado).toBe('advertencia');
  });
});

describe('checkContraste', () => {
  it('passes from 4.5 on and fails below, rounding what it reports', () => {
    expect(checkContraste(PERFIL_V1, { contraste: 4.5 }).resultado).toBe('pasa');
    expect(checkContraste(PERFIL_V1, { contraste: 12.345 })).toMatchObject({ resultado: 'pasa', parametros: { contraste: 12.35, minimo: 4.5 } });
    expect(checkContraste(PERFIL_V1, { contraste: 4.49 })).toMatchObject({ resultado: 'no_pasa', severidad: 'bloqueante' });
    expect(checkContraste(PERFIL_V1, { contraste: 1 }).resultado).toBe('no_pasa');
  });
});

describe('marca_fuente_no_permitida', () => {
  it('accepts the bundled font and refuses any other', () => {
    expect(estado(base).marca_fuente_no_permitida).toBe('pasa');
    for (const fuente of ['Comic Sans MS', 'inter', '', 'Arial']) {
      expect(por(checksMarca({ ...base, fuenteRender: fuente }), 'marca_fuente_no_permitida'), fuente).toMatchObject({
        resultado: 'no_pasa',
        parametros: { fuente_permitida: false },
      });
    }
  });

  it('the allowed fonts are the one the renderer bundles', () => {
    expect(FUENTES_PERMITIDAS).toEqual([FUENTE_POR_DEFECTO]);
  });

  it('never puts the name of the font in the parameters', () => {
    expect(JSON.stringify(checksMarca({ ...base, fuenteRender: 'Fuente Privada Del Cliente' }))).not.toContain('Privada');
  });
});

describe('marca_glifos_no_soportados', () => {
  it('accepts Latin text, accents, ñ and common punctuation', () => {
    expect(estado({ ...base, textosEnPantalla: ['¿Café? ¡Sí! Ñandú — “hoy” 5€ ™'] }).marca_glifos_no_soportados).toBe('pasa');
  });

  it('refuses emoji and scripts the font cannot draw, naming the scenes and counting the characters', () => {
    const check = por(checksMarca({ ...base, textosEnPantalla: ['Hola', 'Fuego 🔥🔥', 'ok', '漢字'] }), 'marca_glifos_no_soportados');
    expect(check).toMatchObject({ resultado: 'no_pasa', parametros: { escenas: [1, 3] } });
    expect(check.parametros.caracteres).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(check)).not.toMatch(/Fuego|漢字/);
  });

  it('passes when there is no on-screen text', () => {
    expect(estado({ ...base, textosEnPantalla: [] }).marca_glifos_no_soportados).toBe('pasa');
  });
});
