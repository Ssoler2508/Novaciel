import { describe, expect, it } from 'vitest';
import { containsText, containsWord, fold, mentionsPrice, mentionsPromotion, mentionsSchedule } from './textMatch.js';

describe('fold', () => {
  it('lower-cases and removes accents', () => {
    expect(fold('Miércoles ÁÉÍÓÚ Ñandú')).toBe('miercoles aeiou nandu');
  });
});

describe('containsWord / containsText', () => {
  it('matches whole words only, ignoring case and accents', () => {
    expect(containsWord('Es GARANTIZADO, claro', 'garantizado')).toBe(true);
    expect(containsWord('Política', 'politica')).toBe(true);
    expect(containsWord('Hablemos de política.', 'Política')).toBe(true);
    expect(containsWord('garantizados', 'garantizado')).toBe(false);
    expect(containsWord('nogarantizado', 'garantizado')).toBe(false);
    expect(containsWord('algo', '')).toBe(false);
    expect(containsWord('a.b', 'a.b')).toBe(true); // regex characters are escaped
    expect(containsWord('axb', 'a.b')).toBe(false);
  });

  it('containsText matches anywhere', () => {
    expect(containsText('Somos EL MEJOR CAFÉ de la ciudad', 'el mejor cafe de la ciudad')).toBe(true);
    expect(containsText('un buen café', 'el mejor café')).toBe(false);
    expect(containsText('algo', '   ')).toBe(false);
  });
});

describe('mentions: price, schedule, promotion', () => {
  it.each([
    'El café cuesta $6.000',
    'Solo 6.000 COP hoy',
    'Precio especial para ti',
    'Only 5 usd',
    '€ 4 el croissant',
    'Nuestra tarifa de lanzamiento',
  ])('price: %s', (idea) => expect(mentionsPrice(idea)).toBe(true));

  it.each(['Abrimos a las 7:00', 'Cerramos a las 7pm', 'Nuestro horario favorito', 'De lunes a sábado', 'We open early', '8 am en punto'])(
    'schedule: %s',
    (idea) => expect(mentionsSchedule(idea)).toBe(true),
  );

  it.each(['2x1 en capuchinos', '20% de descuento', 'Una promoción para ti', 'Gran oferta de apertura', 'Big sale'])(
    'promotion: %s',
    (idea) => expect(mentionsPromotion(idea)).toBe(true),
  );

  it.each([
    'Un vistazo al origen de nuestros granos',
    'Cómo se hornea nuestra torta de zanahoria',
    'Pásate hoy por tu café con calma',
    'La historia de la finca donde nace el café',
  ])('none of the three: %s', (idea) => {
    expect(mentionsPrice(idea)).toBe(false);
    expect(mentionsSchedule(idea)).toBe(false);
    expect(mentionsPromotion(idea)).toBe(false);
  });
});
