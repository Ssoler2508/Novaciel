import { describe, expect, it } from 'vitest';
import { asClienteId } from './clienteId.js';
import { buildUpdate } from './updateBuilder.js';

const CLIENTE = asClienteId('11111111-1111-4111-8111-111111111111');
const ID = '22222222-2222-4222-8222-222222222222';

describe('buildUpdate', () => {
  it('always filters by id and cliente_id', () => {
    const built = buildUpdate('hechos_verificados', ['enunciado', 'fuente'], { enunciado: 'x' }, ID, CLIENTE)!;
    expect(built.sql).toBe(
      'UPDATE hechos_verificados SET enunciado = $1 WHERE id = $2 AND cliente_id = $3 RETURNING *',
    );
    expect(built.values).toEqual(['x', ID, CLIENTE]);
  });

  it('can set a nullable column to NULL and skips undefined ones', () => {
    const built = buildUpdate('t', ['a', 'b'], { a: null, b: undefined }, ID, CLIENTE)!;
    expect(built.sql).toContain('SET a = $1 WHERE');
    expect(built.values).toEqual([null, ID, CLIENTE]);
  });

  it('returns null for an empty patch', () => {
    expect(buildUpdate('t', ['a'], {}, ID, CLIENTE)).toBeNull();
  });

  it('throws when the patch contains id or cliente_id', () => {
    expect(() => buildUpdate('t', ['a'], { id: 'x' }, ID, CLIENTE)).toThrow(/"id"/);
    expect(() => buildUpdate('t', ['a'], { cliente_id: 'x' }, ID, CLIENTE)).toThrow(/"cliente_id"/);
  });

  it('throws when id or cliente_id are in the whitelist', () => {
    expect(() => buildUpdate('t', ['a', 'cliente_id'], { a: 1 }, ID, CLIENTE)).toThrow(/never be updatable/);
    expect(() => buildUpdate('t', ['id'], { a: 1 }, ID, CLIENTE)).toThrow(/never be updatable/);
  });

  it('throws for a column outside the whitelist', () => {
    expect(() => buildUpdate('t', ['a'], { b: 1 }, ID, CLIENTE)).toThrow(/"b"/);
  });
});

describe('asClienteId', () => {
  it('accepts a uuid and rejects anything else', () => {
    expect(asClienteId(ID)).toBe(ID);
    expect(() => asClienteId('not-a-uuid')).toThrow();
    expect(() => asClienteId('')).toThrow();
  });
});
