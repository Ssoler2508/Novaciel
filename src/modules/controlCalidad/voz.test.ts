import { describe, expect, it } from 'vitest';
import { CATALOGO } from './catalogo.js';
import { checksCifras } from './cifras.js';
import { checksReglas } from './reglas.js';
import { idDeCampo, type CampoPublicado } from './tipos.js';
import { checksVoz } from './voz.js';

const base = { esReel: true, escenasConVoz: [] as number[], plantillaRegistrada: true, vozOmitida: null as string | null };
const por = (checks: ReturnType<typeof checksVoz>, codigo: string) => checks.find((c) => c.codigo === codigo)!;

describe('checksVoz', () => {
  it('has no voice check outside reels', () => {
    expect(checksVoz({ ...base, esReel: false, escenasConVoz: [1] })).toEqual([]);
  });

  it('a reel without a voice passes everything', () => {
    const checks = checksVoz(base);
    expect(checks.map((c) => c.codigo)).toEqual(['voz_subtitulos_ausentes', 'voz_etiqueta_ia_pendiente', 'voz_omitida_sin_plantilla']);
    expect(checks.every((c) => c.resultado === 'pasa')).toBe(true);
  });

  it('a voiced reel with its template: passes the subtitles and warns about the synthetic audio', () => {
    const checks = checksVoz({ ...base, escenasConVoz: [1, 3] });
    expect(por(checks, 'voz_subtitulos_ausentes')).toMatchObject({ resultado: 'pasa', parametros: { escenas: [1, 3] } });
    expect(por(checks, 'voz_etiqueta_ia_pendiente')).toMatchObject({ resultado: 'advertencia', severidad: 'advertencia', parametros: { escenas: [1, 3] } });
  });

  it('a voiced reel with no recorded template fails the subtitles check (blocking)', () => {
    const c = por(checksVoz({ ...base, escenasConVoz: [2], plantillaRegistrada: false }), 'voz_subtitulos_ausentes');
    expect(c).toMatchObject({ resultado: 'no_pasa', severidad: 'bloqueante' });
  });

  it('a voice omitted for lack of a template is a warning for the reviewer; other reasons are not', () => {
    expect(por(checksVoz({ ...base, vozOmitida: 'sin_plantilla' }), 'voz_omitida_sin_plantilla')).toMatchObject({ resultado: 'advertencia', severidad: 'advertencia' });
    for (const motivo of ['sin_configuracion', 'sin_proveedor', 'sin_texto', null]) {
      expect(por(checksVoz({ ...base, vozOmitida: motivo }), 'voz_omitida_sin_plantilla').resultado, String(motivo)).toBe('pasa');
    }
  });

  it('records where the reason came from only when it is the audit fallback (an older production)', () => {
    expect(por(checksVoz({ ...base, vozOmitida: 'sin_plantilla', vozOmitidaOrigen: 'columna' }), 'voz_omitida_sin_plantilla').parametros).toEqual({});
    const viejo = por(checksVoz({ ...base, vozOmitida: 'sin_plantilla', vozOmitidaOrigen: 'auditoria' }), 'voz_omitida_sin_plantilla');
    expect(viejo).toMatchObject({ resultado: 'advertencia', parametros: { origen: 'auditoria' } });
  });

  it('puts only scene numbers in the parameters (never text)', () => {
    const json = JSON.stringify(checksVoz({ ...base, escenasConVoz: [1], vozOmitida: 'sin_plantilla' }));
    expect(json).not.toMatch(/[A-Za-z]{12,}/);
  });

  it('the reasons are short Spanish phrases and the two warnings are warnings', () => {
    for (const codigo of ['voz_audio_ausente', 'voz_volumen_fuera_de_rango', 'voz_subtitulos_ausentes'] as const) expect(CATALOGO[codigo].severidad).toBe('bloqueante');
    for (const codigo of ['voz_etiqueta_ia_pendiente', 'voz_omitida_sin_plantilla'] as const) expect(CATALOGO[codigo].severidad).toBe('advertencia');
  });
});

describe('the spoken text goes through the same rule-2 and banned-rule checks (field voz_en_off:N)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const campo = (texto: string, modelo = texto): CampoPublicado => ({ campo: 'voz_en_off', indice: 2, texto, modelo });
  const ahora = new Date('2026-11-02T12:00:00Z');
  const hecho = { id: ID, tipo: 'precio' as const, enunciado: 'el cafe cuesta 4 dolares', vigente_desde: new Date('2026-01-01T00:00:00Z'), vigente_hasta: null };

  it('has the closed field id voz_en_off:N', () => {
    expect(idDeCampo(campo('x'))).toBe('voz_en_off:2');
  });

  it('a free figure in the spoken text fails cifra_libre with that field', () => {
    const c = checksCifras({ campos: [campo('Solo cuesta 4 dolares')], hechos: [], ahora, instantePieza: ahora }).find((x) => x.codigo === 'cifra_libre')!;
    expect(c).toMatchObject({ resultado: 'no_pasa', parametros: { campos: ['voz_en_off:2'] } });
  });

  it('a figure that comes from a cited fact passes', () => {
    const texto = 'Ven hoy, el cafe cuesta 4 dolares';
    const modelo = `Ven hoy, {{hecho:${ID}}}`;
    const checks = checksCifras({ campos: [campo(texto, modelo)], hechos: [hecho], ahora, instantePieza: ahora });
    expect(checks.every((c) => c.resultado === 'pasa')).toBe(true);
  });

  it('a banned word in the spoken text fails regla_prohibida_palabra with that field', () => {
    const c = checksReglas([campo('Es muy barato')], [{ tipo: 'palabra', texto: 'barato' }]).find((x) => x.codigo === 'regla_prohibida_palabra')!;
    expect(c).toMatchObject({ resultado: 'no_pasa', parametros: { campos: ['voz_en_off:2'] } });
  });
});
