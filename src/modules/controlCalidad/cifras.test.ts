import { describe, expect, it } from 'vitest';
import { factToken } from '../directorCreativo/tokens.js';
import { checksCifras, type EntradaCifras, type HechoQC } from './cifras.js';
import type { CampoPublicado, CheckQC } from './tipos.js';

const ID_PRECIO = '11111111-1111-4111-8111-111111111111';
const ID_HORARIO = '22222222-2222-4222-8222-222222222222';
const ID_PROMO = '33333333-3333-4333-8333-333333333333';

const AHORA = new Date('2026-11-10T12:00:00Z');
const PIEZA = new Date('2026-11-12T15:00:00Z');

const hecho = (id: string, tipo: HechoQC['tipo'], enunciado: string, extra: Partial<HechoQC> = {}): HechoQC => ({
  id,
  tipo,
  enunciado,
  vigente_desde: new Date('2026-01-01T00:00:00Z'),
  vigente_hasta: null,
  ...extra,
});
const PRECIO = hecho(ID_PRECIO, 'precio', 'El café cuesta $5');
const HORARIO = hecho(ID_HORARIO, 'horario', 'Abrimos de lunes a viernes de 8 a 5');
const PROMO = hecho(ID_PROMO, 'promocion', 'Dos por uno los martes');

/** A field written by the brief: the model text has the token, the stored text has the fact's text. */
const conHecho = (campo: CampoPublicado['campo'], indice: number, plantilla: string, h: HechoQC): CampoPublicado => ({
  campo,
  indice,
  modelo: plantilla.replace('{h}', factToken(h.id)),
  texto: plantilla.replace('{h}', h.enunciado),
});
const libre = (campo: CampoPublicado['campo'], indice: number, texto: string): CampoPublicado => ({ campo, indice, texto, modelo: texto });

const entrada = (campos: CampoPublicado[], hechos: HechoQC[] = [PRECIO, HORARIO, PROMO], extra: Partial<EntradaCifras> = {}): EntradaCifras => ({
  campos,
  hechos,
  ahora: AHORA,
  instantePieza: PIEZA,
  ...extra,
});
const por = (checks: CheckQC[], codigo: string) => checks.find((c) => c.codigo === codigo)!;
const fallos = (e: EntradaCifras) => checksCifras(e).filter((c) => c.resultado !== 'pasa').map((c) => c.codigo);

describe('checksCifras: rule 2', () => {
  it('returns the three codes, all passing for a text with no figures and no facts', () => {
    const checks = checksCifras(entrada([libre('texto_publicacion', 0, 'Una mañana tranquila en el café')], []));
    expect(checks.map((c) => [c.codigo, c.resultado])).toEqual([
      ['cifra_libre', 'pasa'],
      ['hecho_texto_cambiado', 'pasa'],
      ['hecho_no_vigente', 'pasa'],
    ]);
  });

  it('refuses a free price, and accepts the same price when it comes through a cited fact', () => {
    expect(fallos(entrada([libre('texto_publicacion', 0, 'Hoy el café cuesta $5')]))).toEqual(['cifra_libre']);
    expect(fallos(entrada([conHecho('texto_publicacion', 0, 'Hoy: {h}', PRECIO)]))).toEqual([]);
    // The figure is in the fact's text only: the stored copy and the fact agree.
    expect(por(checksCifras(entrada([libre('texto_publicacion', 0, 'Hoy el café cuesta $5')])), 'cifra_libre').parametros).toEqual({ campos: ['texto_publicacion:0'] });
  });

  it.each([
    ['digits', 'Somos 24 horas'],
    ['a year', 'Desde 2019 contigo'],
    ['a currency sign', 'Todo en €'],
    ['a percentage', 'Mucho por ciento de cariño'],
    ['a percent sign', 'Hecho al %'],
    ['a number in words with a unit', 'Cinco dólares y listo'],
    ['noon', 'Nos vemos a mediodía'],
  ])('refuses a free figure: %s', (_nombre, texto) => {
    expect(fallos(entrada([libre('texto_en_pantalla', 1, texto)]))).toEqual(['cifra_libre']);
  });

  it('a figure in one field does not excuse a figure in another: only the fact text is removed, field by field', () => {
    const campos = [conHecho('texto_publicacion', 0, 'Hoy: {h}', PRECIO), libre('texto_alternativo', 0, 'Una taza de $3')];
    const checks = checksCifras(entrada(campos));
    expect(por(checks, 'cifra_libre')).toMatchObject({ resultado: 'no_pasa', parametros: { campos: ['texto_alternativo:0'] } });
  });

  it('flags a number in a hashtag, but not the plain word of a price in a hashtag', () => {
    expect(fallos(entrada([libre('hashtag', 0, '#2x1')]))).toEqual(['cifra_libre']);
    expect(fallos(entrada([libre('hashtag', 0, '#precios')]))).toEqual([]);
  });

  it('a price, schedule or promotion WORD needs a cited fact of that type somewhere in the piece', () => {
    expect(fallos(entrada([libre('texto_publicacion', 0, 'Consulta nuestros precios')]))).toEqual(['cifra_libre']);
    expect(fallos(entrada([libre('texto_publicacion', 0, 'Mira nuestro horario')]))).toEqual(['cifra_libre']);
    expect(fallos(entrada([libre('texto_publicacion', 0, 'Aprovecha el descuento')]))).toEqual(['cifra_libre']);
    // With a fact of the right type cited in another field of the same piece, the wording is backed.
    const conPrecio = entrada([libre('texto_publicacion', 0, 'Consulta nuestros precios'), conHecho('texto_en_pantalla', 1, '{h}', PRECIO)]);
    expect(fallos(conPrecio)).toEqual([]);
    // A fact of another type does not back it.
    const conHorario = entrada([libre('texto_publicacion', 0, 'Consulta nuestros precios'), conHecho('texto_en_pantalla', 1, '{h}', HORARIO)]);
    expect(fallos(conHorario)).toEqual(['cifra_libre']);
    expect(fallos(entrada([libre('texto_publicacion', 0, 'Mira nuestro horario'), conHecho('texto_en_pantalla', 1, '{h}', HORARIO)]))).toEqual([]);
    expect(fallos(entrada([libre('texto_publicacion', 0, 'Aprovecha el descuento'), conHecho('texto_en_pantalla', 1, '{h}', PROMO)]))).toEqual([]);
  });

  it('refuses a fact that was edited after the piece was written, and names the field and the fact', () => {
    const escrito = conHecho('texto_publicacion', 0, 'Hoy: {h}', PRECIO);
    const editado = hecho(ID_PRECIO, 'precio', 'El café cuesta $6');
    const checks = checksCifras(entrada([escrito], [editado]));
    expect(por(checks, 'hecho_texto_cambiado')).toMatchObject({ resultado: 'no_pasa', parametros: { campos: ['texto_publicacion:0'], hecho_ids: [ID_PRECIO] } });
    // The old figure is no longer covered by the current text of the fact.
    expect(por(checks, 'cifra_libre').resultado).toBe('no_pasa');
  });

  it('compares the fact text in NFC, so an accent written in another form is the same text', () => {
    const nfd = hecho(ID_PRECIO, 'precio', 'El café cuesta $5'.normalize('NFD'));
    expect(fallos(entrada([conHecho('texto_publicacion', 0, 'Hoy: {h}', PRECIO)], [nfd]))).toEqual([]);
  });

  it('refuses a cited fact that expired, or that is not valid at the instant of the piece', () => {
    const campos = [conHecho('texto_publicacion', 0, 'Hoy: {h}', PRECIO)];
    const vencido = hecho(ID_PRECIO, 'precio', PRECIO.enunciado, { vigente_hasta: new Date('2026-11-01T00:00:00Z') });
    expect(por(checksCifras(entrada(campos, [vencido])), 'hecho_no_vigente')).toMatchObject({ resultado: 'no_pasa', parametros: { hecho_ids: [ID_PRECIO] } });
    // Valid now, but it ends before the piece is published.
    const terminaAntes = hecho(ID_PRECIO, 'precio', PRECIO.enunciado, { vigente_hasta: new Date('2026-11-11T00:00:00Z') });
    expect(fallos(entrada(campos, [terminaAntes]))).toEqual(['hecho_no_vigente']);
    // Starts after the piece is published.
    const empiezaDespues = hecho(ID_PRECIO, 'precio', PRECIO.enunciado, { vigente_desde: new Date('2026-11-13T00:00:00Z') });
    expect(fallos(entrada(campos, [empiezaDespues]))).toEqual(['hecho_no_vigente']);
    // The end is exclusive: a fact that ends exactly at the instant is not valid there.
    const terminaJusto = hecho(ID_PRECIO, 'precio', PRECIO.enunciado, { vigente_hasta: PIEZA });
    expect(fallos(entrada(campos, [terminaJusto]))).toEqual(['hecho_no_vigente']);
    expect(fallos(entrada(campos, [PRECIO]))).toEqual([]);
  });

  it('a cited fact that no longer exists is not valid', () => {
    expect(por(checksCifras(entrada([conHecho('texto_publicacion', 0, 'Hoy: {h}', PRECIO)], [])), 'hecho_no_vigente').parametros).toEqual({ hecho_ids: [ID_PRECIO] });
  });

  it('never puts the text of the piece or of a fact in the parameters', () => {
    const campos = [libre('texto_publicacion', 0, 'Secreto 777 en pesos'), conHecho('texto_en_pantalla', 1, '{h}', PRECIO)];
    const editado = hecho(ID_PRECIO, 'precio', 'Otro texto privado de 9 euros');
    expect(JSON.stringify(checksCifras(entrada(campos, [editado])))).not.toMatch(/Secreto|privado|pesos|euros|777/);
  });
});
