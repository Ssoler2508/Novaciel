import { describe, expect, it } from 'vitest';
import { factToken } from '../directorCreativo/tokens.js';
import type { HorarioVetado } from '../planificador/types.js';
import { CATALOGO } from './catalogo.js';
import { checksCifras, type HechoQC } from './cifras.js';
import { checksFuentes } from './fuentes.js';
import { checksMarca } from './marca.js';
import { checksProgramacion } from './programacion.js';
import { checksReglas } from './reglas.js';
import { checksTextos } from './textos.js';
import type { CampoPublicado, CheckQC } from './tipos.js';

// Property: no check ever carries text it was given. There is no property-testing library in the repo (and
// none is added for one test), so this uses a small seeded generator: the same inputs on every run.
// Every generated text holds a unique UPPERCASE marker; after each run the serialised checks must hold none
// of them, and every text value in `parametros` must be a closed identifier.

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20261030);
const entero = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const elegir = <T>(xs: readonly T[]): T => xs[entero(0, xs.length - 1)]!;

const PALABRAS = ['café', 'CAFE', 'gratis', 'precio', 'precios', '5', '$7', '24', 'horario', 'descuento', '2x1', 'Ñandú', '🔥', '漢字', 'promo', 'hoy', 'mañana', '#', '%', 'cinco dólares', 'mediodía', '  ', 'a'.repeat(120)];
const ZONAS = ['America/New_York', 'America/Los_Angeles', 'UTC', 'America/Bogota'];
const TIPOS = ['precio', 'horario', 'promocion', 'cifra', 'otro'] as const;
const FORMATOS = ['reel', 'carrusel', 'post', 'historia'] as const;
const SAFE = /^[a-z0-9_.:-]{1,80}$/;

let contadorMarcas = 0;
const marcas: string[] = [];
function conMarca(): string {
  const marca = `MARCA${(contadorMarcas++).toString(36).toUpperCase()}Q`;
  marcas.push(marca);
  const palabras = Array.from({ length: entero(0, 5) }, () => elegir(PALABRAS));
  palabras.splice(entero(0, palabras.length), 0, marca);
  return palabras.join(' ');
}

function uuid(): string {
  const hex = () => Array.from({ length: 4 }, () => entero(0, 15).toString(16)).join('');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-8${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

function hora(): string {
  return `${String(entero(0, 23)).padStart(2, '0')}:${String(entero(0, 59)).padStart(2, '0')}`;
}

function ventanas(): HorarioVetado[] {
  return Array.from({ length: entero(0, 3) }, () => {
    const a = entero(0, 22 * 60);
    const b = entero(a + 1, 23 * 60 + 59);
    const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return { ...(rnd() < 0.5 ? { dia: elegir(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'] as const) } : {}), desde: fmt(a), hasta: fmt(b) };
  });
}

function revisarParametros(valor: unknown, ruta: string): void {
  if (typeof valor === 'string') expect(SAFE.test(valor), `${ruta} = ${valor}`).toBe(true);
  else if (Array.isArray(valor)) valor.forEach((v, i) => revisarParametros(v, `${ruta}[${i}]`));
  else expect(['number', 'boolean'], ruta).toContain(typeof valor);
}

function revisar(checks: CheckQC[]): void {
  const json = JSON.stringify(checks);
  for (const marca of marcas) expect(json.includes(marca), `${marca} leaked`).toBe(false);
  for (const c of checks) {
    expect([CATALOGO[c.codigo].motivo, 'Cumple.'], c.codigo).toContain(c.motivo);
    for (const [clave, valor] of Object.entries(c.parametros)) revisarParametros(valor, `${c.codigo}.${clave}`);
  }
}

const ITERACIONES = 1500;

describe('property: no parameter ever carries text of the client', () => {
  it(`holds over ${ITERACIONES} random inputs for every check family`, () => {
    const ahora = new Date('2026-06-01T00:00:00Z');
    for (let i = 0; i < ITERACIONES; i++) {
      marcas.length = 0;

      // Text of the piece, facts and rules.
      const hechos: HechoQC[] = Array.from({ length: entero(0, 3) }, () => ({
        id: uuid(),
        tipo: elegir(TIPOS),
        enunciado: conMarca(),
        vigente_desde: new Date(ahora.getTime() + entero(-90, 30) * 86_400_000),
        vigente_hasta: rnd() < 0.5 ? null : new Date(ahora.getTime() + entero(-30, 120) * 86_400_000),
      }));
      const campos: CampoPublicado[] = Array.from({ length: entero(1, 6) }, (_v, k) => {
        const cita = hechos.length > 0 && rnd() < 0.6 ? elegir(hechos) : null;
        const texto = conMarca();
        return {
          campo: elegir(['texto_publicacion', 'hashtag', 'texto_alternativo', 'texto_en_pantalla', 'ubicacion'] as const),
          indice: k,
          texto: cita && rnd() < 0.7 ? `${texto} ${cita.enunciado}` : texto,
          ...(cita ? { modelo: `${conMarca()} ${factToken(cita.id)}` } : rnd() < 0.5 ? { modelo: conMarca() } : {}),
        };
      });
      const reglas = Array.from({ length: entero(0, 3) }, () => ({
        tipo: elegir(['palabra', 'promesa', 'tema', 'elemento_visual'] as const),
        texto: rnd() < 0.5 ? elegir(PALABRAS) : conMarca(),
      }));

      const checks: CheckQC[] = [
        ...checksReglas(campos, reglas),
        ...checksCifras({ campos, hechos, ahora, instantePieza: new Date(ahora.getTime() + entero(0, 60) * 86_400_000) }),
        ...checksTextos({
          formato: elegir(FORMATOS),
          textoPublicacion: conMarca(),
          hashtags: Array.from({ length: entero(0, 12) }, () => (rnd() < 0.5 ? conMarca() : `#${conMarca().replace(/\W/g, '')}`)),
          textosAlternativos: Array.from({ length: entero(0, 6) }, () => (rnd() < 0.2 ? '' : conMarca())),
          ubicacion: rnd() < 0.3 ? null : conMarca(),
          numArchivos: entero(0, 12),
          numEscenasReel: rnd() < 0.3 ? null : entero(0, 8),
        }),
        ...checksProgramacion({
          fechaHora: new Date(ahora.getTime() + entero(-5, 400) * 3_600_000 + entero(0, 59) * 60_000),
          ahora,
          zona: elegir(ZONAS),
          horariosVetados: ventanas(),
        }),
        ...checksMarca({
          perfilMarcaId: uuid(),
          kitVisual: rnd() < 0.2 ? conMarca() : { colores: { principal: rnd() < 0.5 ? conMarca() : `#${hora().replace(':', '')}00`, secundarios: [conMarca()], acento: '#ffffff' } },
          fuenteRender: rnd() < 0.5 ? 'Inter' : conMarca(),
          textosEnPantalla: Array.from({ length: entero(0, 5) }, () => conMarca()),
          perfilOrigen: rnd() < 0.5 ? 'produccion' : 'brief',
        }),
        ...checksFuentes({
          tomas: Array.from({ length: entero(0, 6) }, (_v, k) => ({ orden: k + 1, fuente: rnd() < 0.5 ? elegir(['media_real', 'faltante', 'generacion_ia', 'animacion_ia']) : conMarca(), mediaId: rnd() < 0.5 ? uuid() : null })),
          archivos: Array.from({ length: entero(0, 4) }, (_v, k) => ({ orden: k + 1, mediaId: uuid() })),
          fuentesReel: Array.from({ length: entero(0, 4) }, (_v, k) => ({ ordenArchivo: 1, escena: k + 1, mediaId: uuid() })),
          biblioteca: new Set(),
        }),
      ];
      revisar(checks);
    }
  }, 120_000);

  it('the generator really builds failing inputs (so the property is not vacuous)', () => {
    const resultado = checksTextos({
      formato: 'carrusel',
      textoPublicacion: 'a'.repeat(2001),
      hashtags: ['sin numeral'],
      textosAlternativos: [],
      ubicacion: 'u'.repeat(200),
      numArchivos: 2,
      numEscenasReel: null,
    });
    expect(resultado.filter((c) => c.resultado === 'no_pasa').length).toBeGreaterThanOrEqual(5);
  });
});
