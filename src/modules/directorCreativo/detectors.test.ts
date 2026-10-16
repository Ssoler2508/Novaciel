import { describe, expect, it } from 'vitest';
import { mentionsAi, mentionsAiGenerationRequest, mentionsNumber } from './detectors.js';

describe('mentionsNumber (rule 2)', () => {
  it.each([
    'Solo 10 dias',
    'Llega a las 7',
    '3x2 en todo',
    'Abrimos a las 2 pm',
    'Cuesta $ ',
    'Cuesta 5€',
    'Ahora £',
    'Descuento del 20%',
    'diez por ciento menos',
    'ten percent off',
    'un porcentaje especial',
    'Nos vemos a mediodía',
    'Hasta la medianoche',
    'Open until midnight',
    'cinco dólares',
    'mil pesos',
    'ten dollars',
    'dos horas',
    'ocho pm',
    'twenty euros',
    'Llevamos ocho años',
    'ten years of coffee',
    'en dos días',
    'Año ٢٠٢٦', // other decimal digits
  ])('flags %s', (text) => {
    expect(mentionsNumber(text)).toBe(true);
  });

  it.each([
    'Hecho con calma, como siempre.',
    'Una taza para cada mañana',
    'Un café y un libro',
    'one of a kind',
    'Cinco sentidos en una taza', // a number word without a unit is not a claim
    'Nos vemos pronto',
    'I am here', // "am" alone is not a time
    'Tres razones para volver',
  ])('lets %s through', (text) => {
    expect(mentionsNumber(text)).toBe(false);
  });
});

describe('mentionsAiGenerationRequest', () => {
  it.each([
    'Genera una imagen del plato',
    'Please generate a photo of the shop',
    'generar un video del local',
    'Hecho con Midjourney',
    'usa DALL-E',
    'dalle para el fondo',
    'Stable Diffusion para el local',
    'una toma de Sora',
    'stock photo de una cafetería',
    'banco de imágenes',
    'Imagen generada con IA',
    'foto generada por inteligencia artificial',
    'AI-generated people',
    'ai generated scene',
    'IA-generado',
  ])('flags %s', (text) => {
    expect(mentionsAiGenerationRequest(text)).toBe(true);
  });

  it.each([
    'Hecho con calma, como siempre.',
    'Somos una empresa de inteligencia artificial', // a plain mention is not a request
    'Nuestro asistente de IA responde dudas',
    'Generamos confianza cada día', // "generamos" is not a request for imagery
    'Mira el video del proceso',
  ])('lets %s through', (text) => {
    expect(mentionsAiGenerationRequest(text)).toBe(false);
  });
});

describe('mentionsAi', () => {
  it('detects plain mentions, accent- and case-insensitive, as whole words', () => {
    for (const text of ['Hecho con IA', 'made with AI', 'inteligencia artificial', 'Artificial Intelligence', 'usa la ia']) {
      expect(mentionsAi(text)).toBe(true);
    }
    for (const text of ['Hecho con calma', 'avaricia', 'mail', 'dial']) expect(mentionsAi(text)).toBe(false);
  });
});
