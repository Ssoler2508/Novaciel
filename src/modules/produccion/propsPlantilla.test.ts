import { describe, expect, it, vi } from 'vitest';
import { elegirColores } from './colors.js';
import { PlantillaInvalidaError, TextDoesNotFitError, UnsupportedGlyphsError } from './errors.js';
import { PLANTILLAS } from './plantillas.js';
import { construirPropsPlantilla, esquemaPropsPlantilla, type EntradaPropsPlantilla, type PropsPlantilla } from './propsPlantilla.js';
import type { Medir } from './textLayout.js';
import { palabrasDe } from './tiemposPalabras.js';

const medir: Medir = (texto, tamano) => [...texto].length * tamano * 0.5;
const colores = elegirColores({ colores: { principal: '#1f3a5f', secundarios: ['#f4e9d8'], acento: '#e07a3f' } });

function entrada(over: Partial<EntradaPropsPlantilla> & { texto?: string; orden?: number; fotogramas?: number } = {}): EntradaPropsPlantilla {
  return {
    plantilla: over.plantilla ?? { id: 'palabra_a_palabra', version: 1 },
    escena: { orden: over.orden ?? 2, texto: over.texto ?? 'Cada mañana tostamos el café', fotogramas: over.fotogramas ?? 150 },
    fps: over.fps ?? 30,
    colores: over.colores ?? colores,
    ancho: over.ancho ?? 1080,
    alto: over.alto ?? 1920,
    medir: over.medir ?? medir,
  };
}
const props = (over?: Parameters<typeof entrada>[0]): PropsPlantilla => construirPropsPlantilla(entrada(over))!;
const palabras = (p: PropsPlantilla) => p.lineas.flatMap((l) => l.palabras);

describe('construirPropsPlantilla: each template', () => {
  it('palabra_a_palabra: words at their own times, bottom of the safe zone, colors from the kit', () => {
    const p = props();
    expect(p).toMatchObject({
      plantilla: 'palabra_a_palabra',
      version: 1,
      modo: 'palabras',
      posicion: 'abajo',
      ancho: 1080,
      alto: 1920,
      fps: 30,
      fotogramas: 150,
      fuente: 'Inter',
      colores: { texto: colores.texto, scrim: colores.scrim, alfa: colores.alfa },
    });
    const w = palabras(p);
    expect(w.map((x) => x.texto)).toEqual(['Cada', 'mañana', 'tostamos', 'el', 'café']);
    expect(w[0]!.inicioMs).toBe(150); // the lead-in
    expect(w.at(-1)!.finMs).toBe(5000); // the scene: 150 frames at 30 fps
    expect(w.at(-1)!.finFotograma).toBe(150);
    for (let i = 1; i < w.length; i++) expect(w[i]!.inicioMs).toBeGreaterThan(w[i - 1]!.inicioMs);
    expect(esquemaPropsPlantilla.safeParse(p).success).toBe(true);
  });

  it('frames follow the milliseconds: round(ms x fps / 1000), never out of the scene, never going back', () => {
    const w = palabras(props({ fotogramas: 90, texto: 'uno dos tres cuatro cinco seis' }));
    let anterior = 0;
    for (const x of w) {
      expect(x.inicioFotograma).toBe(Math.min(89, Math.max(anterior, Math.round((x.inicioMs * 30) / 1000))));
      expect(x.inicioFotograma).toBeLessThan(90);
      expect(x.finFotograma).toBeGreaterThanOrEqual(x.inicioFotograma);
      expect(x.finFotograma).toBeLessThanOrEqual(90);
      anterior = x.inicioFotograma;
    }
    expect(w.at(-1)!.finFotograma).toBe(90);
  });

  it('barra_inferior: the whole text appears together at the lead-in and stays to the end', () => {
    const p = props({ plantilla: { id: 'barra_inferior', version: 1 } });
    expect(p).toMatchObject({ plantilla: 'barra_inferior', modo: 'bloque', posicion: 'abajo' });
    const w = palabras(p);
    expect(new Set(w.map((x) => x.inicioMs))).toEqual(new Set([150]));
    expect(new Set(w.map((x) => x.finMs))).toEqual(new Set([5000]));
    expect(new Set(w.map((x) => x.inicioFotograma))).toEqual(new Set([5])); // 150 ms at 30 fps
  });

  it('titulo_y_palabras: scene 1 is a centered title card, the other scenes go word by word at the bottom', () => {
    const t = { id: 'titulo_y_palabras', version: 1 };
    const primera = props({ plantilla: t, orden: 1 });
    const segunda = props({ plantilla: t, orden: 2 });
    expect(primera).toMatchObject({ modo: 'titulo', posicion: 'centro' });
    expect(segunda).toMatchObject({ modo: 'palabras', posicion: 'abajo' });
    expect(new Set(palabras(primera).map((x) => x.inicioMs)).size).toBe(1); // together
    expect(new Set(palabras(segunda).map((x) => x.inicioMs)).size).toBeGreaterThan(1);
    expect(primera.tamano).toBeGreaterThan(segunda.tamano - 1e-9); // larger range for the title
  });

  it('every template of the registry builds props that pass its strict schema, in every scene position', () => {
    for (const t of PLANTILLAS) {
      for (const orden of [1, 2, 5]) {
        const p = props({ plantilla: { id: t.id, version: t.version }, orden });
        expect(esquemaPropsPlantilla.safeParse(p).success, `${t.id} ${orden}`).toBe(true);
        expect(p.scrim.alto).toBeGreaterThan(0);
        expect(p.scrim.y + p.scrim.alto).toBeLessThanOrEqual(1920);
      }
    }
  });

  it('a small canvas works too (the layout scales with the width)', () => {
    const p = props({ ancho: 540, alto: 960, medir: (t, s) => [...t].length * s * 0.5 });
    expect(p.ancho).toBe(540);
    expect(p.tamano).toBeLessThanOrEqual(36 + 1e-9);
  });
});

describe('construirPropsPlantilla: refusals', () => {
  it('no text, no layer: empty and whitespace-only text give null and nothing is measured', () => {
    const espia = vi.fn(medir);
    for (const t of PLANTILLAS) {
      for (const texto of ['', '   ', '\n\t', '\u00a0']) {
        expect(construirPropsPlantilla(entrada({ plantilla: { id: t.id, version: t.version }, texto, medir: espia }))).toBeNull();
      }
    }
    expect(espia).not.toHaveBeenCalled();
  });

  it('refuses an unknown template or version with a typed error', () => {
    for (const plantilla of [{ id: 'no_existe', version: 1 }, { id: 'barra_inferior', version: 9 }, { id: '', version: 1 }]) {
      expect(() => construirPropsPlantilla(entrada({ plantilla }))).toThrow(expect.objectContaining({ name: 'PlantillaInvalidaError', razon: 'plantilla_desconocida' }));
    }
  });

  it('refuses characters the bundled font cannot draw BEFORE any layout or measure', () => {
    const espia = vi.fn(medir);
    for (const texto of ['Hola 😀', '你好', 'مرحبا', 'ok \u0301\u0300\u0301 ✓']) {
      expect(() => construirPropsPlantilla(entrada({ texto, medir: espia })), texto).toThrow(UnsupportedGlyphsError);
    }
    expect(espia).not.toHaveBeenCalled();
  });

  it('refuses invalid scene, fps and canvas values, naming the fields and never the text', () => {
    const casos: [Partial<Parameters<typeof entrada>[0]>, string][] = [
      [{ fotogramas: 0 }, 'escena.fotogramas'],
      [{ fotogramas: 1.5 }, 'escena.fotogramas'],
      [{ fotogramas: 999_999 }, 'escena.fotogramas'],
      [{ orden: 0 }, 'escena.orden'],
      [{ fps: 0 }, 'fps'],
      [{ ancho: 10 }, 'ancho'],
      [{ alto: 99_999 }, 'alto'],
    ];
    for (const [over, campo] of casos) {
      let error: unknown;
      try {
        construirPropsPlantilla(entrada({ ...over, texto: 'TEXTO-SECRETO-DEL-CLIENTE' }));
      } catch (e) {
        error = e;
      }
      expect(error, campo).toBeInstanceOf(PlantillaInvalidaError);
      expect((error as PlantillaInvalidaError).razon).toBe('entrada_invalida');
      expect((error as PlantillaInvalidaError).campos).toContain(campo);
      expect(JSON.stringify({ m: (error as Error).message, c: (error as PlantillaInvalidaError).campos })).not.toContain('SECRETO');
    }
  });

  it('text that does not fit is refused with the 7a error, not cut', () => {
    expect(() => construirPropsPlantilla(entrada({ texto: 'palabra '.repeat(200) }))).toThrow(TextDoesNotFitError);
    expect(() => construirPropsPlantilla(entrada({ texto: 'a'.repeat(300) }))).toThrow(TextDoesNotFitError);
  });

  it('a scene with less than one millisecond per word is refused by the timing', () => {
    expect(() => construirPropsPlantilla(entrada({ texto: Array.from({ length: 12 }, (_v, i) => `w${i}`).join(' '), fotogramas: 1, fps: 120 }))).toThrow(
      expect.objectContaining({ name: 'TiemposInvalidosError' }),
    );
  });
});

describe('the strict schema', () => {
  const ok = () => JSON.parse(JSON.stringify(props())) as Record<string, unknown>;

  it('refuses an extra field anywhere, a wrong font, a color that is not #rrggbb and inconsistent times', () => {
    const casos: ((p: Record<string, any>) => void)[] = [
      (p) => (p.extra = 1),
      (p) => (p.lineas[0].extra = 1),
      (p) => (p.lineas[0].palabras[0].extra = 1),
      (p) => (p.fuente = 'Comic Sans'),
      (p) => (p.colores.texto = 'red'),
      (p) => (p.colores.scrim = '#FFF'),
      (p) => (p.modo = 'bloque'),
      (p) => (p.posicion = 'centro'),
      (p) => (p.lineas[0].palabras[0].finMs = -1),
      (p) => (p.lineas[0].palabras[0].finFotograma = 99_999),
      (p) => (p.lineas[0].palabras[0].inicioFotograma = 150),
      (p) => (p.lineas[0].palabras[0].texto = 'dos palabras'),
      (p) => (p.lineas[0].palabras[0].texto = ''),
      (p) => (p.plantilla = 'otra'),
      (p) => delete p.scrim,
    ];
    for (const [i, muta] of casos.entries()) {
      const p = ok();
      muta(p as Record<string, any>);
      expect(esquemaPropsPlantilla.safeParse(p).success, `caso ${i}`).toBe(false);
    }
    expect(esquemaPropsPlantilla.safeParse(ok()).success).toBe(true);
  });

  it('refuses words that go back in time', () => {
    const p = ok() as { lineas: { palabras: { inicioFotograma: number }[] }[] };
    p.lineas[0]!.palabras[1]!.inicioFotograma = 0;
    p.lineas[0]!.palabras[0]!.inicioFotograma = 20;
    expect(esquemaPropsPlantilla.safeParse(p).success).toBe(false);
  });
});

// ---- PROPERTY: client text only ever appears in the declared text fields ---------------------------------

describe('property: random client text only appears in lineas[].palabras[].texto', () => {
  let seed = 7_000_007;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Pieces that look like markup, URLs, templates, scripts and commands, mixed with normal words.
  const trozos = [
    'Hola', 'mañana', 'café', 'niño', 'Qué', '¿Cuánto?', '¡Ven!', 'a', 'sí', '50%', '$6.000',
    '<script>alert(1)</script>', '<img', 'src=x', 'onerror=alert(1)>', 'javascript:alert(1)', 'https://evil.example/x.png',
    'http://localhost:3000', '`rm', '-rf`', '$(whoami)', '${process.env.X}', '{{constructor}}', '{x}', '"quoted"', "it's",
    '&amp;', '&#60;', '\\n', 'a/b', '../../etc/passwd', 'file:///C:/x', 'data:text/html,<b>', '--flag', "'; DROP TABLE x;--",
    'extraordinariamente', 'url(http://x)', '@import', 'style="x"', '%s', '%d',
  ];
  const textoAleatorio = () => {
    const n = 1 + Math.floor(rnd() * 9);
    return Array.from({ length: n }, () => trozos[Math.floor(rnd() * trozos.length)]!).join(rnd() < 0.15 ? '\n' : ' ');
  };

  /** Every string in a JSON value, with its path. */
  function cadenas(valor: unknown, ruta = ''): [string, string][] {
    if (typeof valor === 'string') return [[ruta, valor]];
    if (Array.isArray(valor)) return valor.flatMap((v, i) => cadenas(v, `${ruta}[${i}]`));
    if (valor !== null && typeof valor === 'object') return Object.entries(valor).flatMap(([k, v]) => cadenas(v, ruta === '' ? k : `${ruta}.${k}`));
    return [];
  }
  const CAMPO_DECLARADO = /^lineas\[\d+\]\.palabras\[\d+\]\.texto$/;
  const CONJUNTO_FIJO = new Set<string>([...PLANTILLAS.map((t) => t.id), 'bloque', 'palabras', 'titulo', 'abajo', 'centro', 'Inter']);
  const COLOR = /^#[0-9a-f]{6}$/;

  it('holds for 500 random texts on every template and scene position', () => {
    let construidos = 0;
    for (let caso = 0; caso < 500; caso++) {
      const texto = textoAleatorio();
      const t = PLANTILLAS[caso % PLANTILLAS.length]!;
      const orden = 1 + (caso % 3);
      let p: PropsPlantilla | null;
      try {
        p = construirPropsPlantilla(entrada({ plantilla: { id: t.id, version: t.version }, orden, texto, fotogramas: 300 }));
      } catch (e) {
        // A text can legitimately be refused (it does not fit): the refusal never carries the text.
        expect(e).toBeInstanceOf(Error);
        expect(`${(e as Error).message} ${JSON.stringify(e)}`).not.toContain(texto.split(/\s+/)[0]!.length > 6 ? texto.split(/\s+/)[0]! : '\u0000');
        continue;
      }
      expect(p).not.toBeNull();
      construidos++;
      const declaradas: string[] = [];
      for (const [ruta, valor] of cadenas(p)) {
        if (CAMPO_DECLARADO.test(ruta)) declaradas.push(valor);
        else expect(CONJUNTO_FIJO.has(valor) || COLOR.test(valor), `${ruta} = ${valor}`).toBe(true);
      }
      // The declared fields are exactly the words of the text, in order.
      expect(declaradas).toEqual(palabrasDe(texto));
      // Plain JSON: it survives a round trip (nothing exotic travels to the composition).
      expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    }
    // The property is not vacuous: nearly all random texts were really built.
    expect(construidos).toBeGreaterThan(450);
  });

  it('the text never reaches the props through a key either (keys come from a fixed list)', () => {
    const CLAVES = new Set([
      'plantilla', 'version', 'ancho', 'alto', 'fps', 'fotogramas', 'fuente', 'colores', 'texto', 'scrim', 'alfa', 'y', 'tamano', 'interlineadoPx',
      'bloqueArriba', 'posicion', 'modo', 'lineas', 'palabras', 'inicioMs', 'finMs', 'inicioFotograma', 'finFotograma',
    ]);
    const claves = (v: unknown): string[] =>
      Array.isArray(v) ? v.flatMap(claves) : v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...claves(x)]) : [];
    for (let caso = 0; caso < 100; caso++) {
      const p = construirPropsPlantilla(entrada({ texto: textoAleatorio(), fotogramas: 300 }));
      if (p) for (const k of claves(p)) expect(CLAVES.has(k) || k === 'alto', k).toBe(true);
    }
  });
});
