import { describe, expect, it } from 'vitest';
import { reglaViolada } from './matcher.js';

describe('reglaViolada', () => {
  it.each([
    ['palabra', 'cafe', 'Un CAFÉ por favor', true],
    ['palabra', 'cafe', 'Una cafetería', false],
    ['palabra', 'cafe', '¡café!', true],
    ['palabra', 'cafe', '', false],
    ['promesa', 'sin azucar', 'Café SIN AZÚCAR añadida', true],
    ['promesa', 'garantizado', 'Resultados GARANTIZADOS', true],
    ['promesa', 'garantizado', 'Con garantía de calidad', false],
    ['tema', 'cafe', 'Una cafetería', true],
    ['tema', 'politica', 'Hablemos de arte', false],
    ['elemento_visual', 'cafe', 'Un café', false],
  ] as const)('%s "%s" in "%s" is %s', (tipo, texto, enTexto, esperado) => {
    expect(reglaViolada(enTexto, { tipo, texto })).toBe(esperado);
  });

  it('an empty rule text never matches', () => {
    for (const tipo of ['palabra', 'promesa', 'tema'] as const) expect(reglaViolada('cualquier texto', { tipo, texto: '   ' })).toBe(false);
  });
});
