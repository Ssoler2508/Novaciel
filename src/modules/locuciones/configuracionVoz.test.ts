import { describe, expect, it } from 'vitest';
import { ConfiguracionVozInvalidaError, vozDelCliente } from './configuracionVoz.js';

const BASE = { habilitada: true, voice_id: 'VozFicticia_1', idioma: 'es' };

describe('vozDelCliente', () => {
  it('has no voice without a locucion block, with a disabled one, or with a profile that is not an object', () => {
    for (const voz of [undefined, null, {}, { trato: 'tu' }, { locucion: null }, { locucion: { ...BASE, habilitada: false } }, 'texto', 7]) {
      expect(vozDelCliente(voz), JSON.stringify(voz)).toBeNull();
    }
  });

  it('reads the voice and fills the defaults', () => {
    expect(vozDelCliente({ trato: 'tu', locucion: BASE })).toEqual({
      vozId: 'VozFicticia_1',
      ajustes: { estabilidad: 0.5, similitud: 0.75, estilo: 0, velocidad: 1, refuerzoVoz: true, idioma: 'es' },
    });
  });

  it('reads every setting', () => {
    const v = vozDelCliente({ locucion: { ...BASE, estabilidad: 0.2, similitud: 0.9, estilo: 0.4, velocidad: 1.1, refuerzo_voz: false } });
    expect(v?.ajustes).toEqual({ estabilidad: 0.2, similitud: 0.9, estilo: 0.4, velocidad: 1.1, refuerzoVoz: false, idioma: 'es' });
  });

  it('refuses an invalid block, naming the fields and never the values', () => {
    const secreto = 'ruta/../con espacios y texto del cliente';
    const casos: [Record<string, unknown>, string][] = [
      [{ ...BASE, voice_id: secreto }, 'voice_id'],
      [{ ...BASE, voice_id: '' }, 'voice_id'],
      [{ ...BASE, idioma: 'ES' }, 'idioma'],
      [{ ...BASE, idioma: 'esp' }, 'idioma'],
      [{ ...BASE, estabilidad: 1.5 }, 'estabilidad'],
      [{ ...BASE, velocidad: 2 }, 'velocidad'],
      [{ ...BASE, velocidad: 0.5 }, 'velocidad'],
      [{ ...BASE, habilitada: 'si' }, 'habilitada'],
      [{ voice_id: 'x', idioma: 'es' }, 'habilitada'],
    ];
    for (const [locucion, campo] of casos) {
      let error: unknown;
      try {
        vozDelCliente({ locucion });
      } catch (e) {
        error = e;
      }
      expect(error, campo).toBeInstanceOf(ConfiguracionVozInvalidaError);
      expect((error as ConfiguracionVozInvalidaError).campos).toContain(campo);
      expect((error as Error).message).not.toContain(secreto);
    }
  });

  it('has no field for a cloned voice: unknown keys are refused', () => {
    expect(() => vozDelCliente({ locucion: { ...BASE, clonar: true } })).toThrow(ConfiguracionVozInvalidaError);
    expect(() => vozDelCliente({ locucion: { ...BASE, muestra_de_voz: 'x' } })).toThrow(ConfiguracionVozInvalidaError);
  });

  it('a locucion block that is not an object is invalid, not silently ignored', () => {
    expect(() => vozDelCliente({ locucion: 'si' })).toThrow(ConfiguracionVozInvalidaError);
    expect(() => vozDelCliente({ locucion: [] })).toThrow(ConfiguracionVozInvalidaError);
  });
});
