import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FactTokenError } from './errors.js';
import { extractFactTokenIds, factToken, hasMalformedToken, renderFactTokens, stripFactTokens, tokenIdsIn } from './tokens.js';
import type { HechoBrief } from './types.js';

const AT = new Date('2026-11-03T15:00:00Z');
const hecho = (enunciado: string, overrides: Partial<HechoBrief> = {}): HechoBrief => ({
  id: randomUUID(),
  tipo: 'precio',
  enunciado,
  vigente_desde: new Date('2026-10-01T00:00:00Z'),
  vigente_hasta: null,
  ...overrides,
});

describe('fact tokens', () => {
  it('reads the ids of well-formed tokens, lower-cased, repeats included', () => {
    const id = randomUUID();
    expect(tokenIdsIn(`a ${factToken(id.toUpperCase())} b ${factToken(id)}`)).toEqual([id, id]);
    expect(tokenIdsIn('no tokens {{hecho:not-an-id}}')).toEqual([]);
  });

  it('strips tokens and spots malformed ones', () => {
    const id = randomUUID();
    expect(stripFactTokens(`x${factToken(id)}y`)).toBe('x y');
    expect(hasMalformedToken(`ok ${factToken(id)}`)).toBe(false);
    for (const text of ['{{hecho:abc}}', '{{precio}}', `${factToken(id)} }}`, '{{ hecho:x', `{{hecho:${id}`]) {
      expect(hasMalformedToken(text)).toBe(true);
    }
  });

  it('collects the distinct ids of a whole nested content, in order', () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const content = { x: `${factToken(a)}`, y: [{ z: `${factToken(b)} ${factToken(a)}` }], n: 3 };
    expect(extractFactTokenIds(content)).toEqual([a, b]);
  });
});

describe('renderFactTokens', () => {
  it('replaces every token (several, repeated, nested) with the stored value and keeps the shape', () => {
    const precio = hecho('El café cuesta $6.000');
    const horario = hecho('Abrimos de 7:00 a 19:00', { tipo: 'horario' });
    const content = {
      gancho: `Hoy: ${factToken(precio.id)}`,
      escenas: [{ orden: 1, texto: `${factToken(precio.id)} y ${factToken(horario.id)}`, toma: { media_id: null } }],
      lista: ['sin token', `${factToken(horario.id)}`],
    };
    expect(renderFactTokens(content, [precio, horario], AT)).toEqual({
      gancho: 'Hoy: El café cuesta $6.000',
      escenas: [{ orden: 1, texto: 'El café cuesta $6.000 y Abrimos de 7:00 a 19:00', toma: { media_id: null } }],
      lista: ['sin token', 'Abrimos de 7:00 a 19:00'],
    });
    // The input is not modified.
    expect(content.gancho).toContain('{{hecho:');
  });

  it('never leaves a token behind', () => {
    const h = hecho('Valor');
    const out = JSON.stringify(renderFactTokens({ a: factToken(h.id), b: [factToken(h.id)] }, [h], AT));
    expect(out).not.toContain('{{hecho:');
  });

  it('fails with an unknown fact, carrying the id only', () => {
    const known = hecho('Valor');
    const unknown = randomUUID();
    try {
      renderFactTokens({ a: factToken(unknown) }, [known], AT);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FactTokenError);
      expect(error).toMatchObject({ kind: 'unknown', hechoId: unknown });
      expect((error as Error).message).not.toContain('Valor');
    }
  });

  it('fails with an expired fact (ended, or not started yet)', () => {
    const ended = hecho('Termina', { vigente_hasta: new Date('2026-11-03T15:00:00Z') });
    const future = hecho('Empieza', { vigente_desde: new Date('2026-11-03T15:00:01Z') });
    for (const h of [ended, future]) {
      expect(() => renderFactTokens({ a: factToken(h.id) }, [h], AT)).toThrow(expect.objectContaining({ kind: 'expired', hechoId: h.id }));
    }
    const ok = hecho('Vigente', { vigente_hasta: new Date('2026-11-03T15:00:01Z') });
    expect(renderFactTokens({ a: factToken(ok.id) }, [ok], AT)).toEqual({ a: 'Vigente' });
  });

  it('treats a token that survives rendering as a bug', () => {
    const tricky = hecho(`otro ${factToken(randomUUID())}`);
    expect(() => renderFactTokens({ a: factToken(tricky.id) }, [tricky], AT)).toThrow(expect.objectContaining({ kind: 'leftover' }));
  });
});
