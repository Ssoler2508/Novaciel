import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createPrecioModelo, createTope } from '../../../tests/utils/factories/index.js';
import { producibleWorld } from '../../../tests/utils/produccionWorld.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import type { Db } from '../../db/types.js';
import { FakeVoiceProvider } from '../../lib/ai/voice/fakeVoiceProvider.js';
import { createLogger } from '../../lib/logger/index.js';
import { getBriefActual } from '../directorCreativo/guionesRepository.js';
import { ConfiguracionVozInvalidaError } from '../locuciones/configuracionVoz.js';
import { DuracionReelFueraDeRangoError, LocucionEntradaInvalidaError, LocucionMasLargaQueEscenaError } from '../locuciones/errors.js';
import { UnsupportedGlyphsError } from './errors.js';
import { prepararVozDelReel, VozEscenaInvalidaError, type PrepararVozArgs, type VozOmitida } from './vozReel.js';

const SISTEMA = { tipo: 'sistema' } as const;
const CLIP = { bytes: Buffer.from('clip'), ancho: 720, alto: 1280, duracionMs: 6000 };
const LOCUCION = { habilitada: true, voice_id: 'VozFicticia1', idioma: 'es' };
const TEXTOS = ['Cada manana tostamos cafe de origen', undefined, 'Pasa por tu cafe de la casa'];

interface Opciones {
  locucion?: Record<string, unknown> | null;
  voces?: (string | undefined)[];
  sceneSeconds?: number;
  sinProveedor?: boolean;
  plantilla?: boolean;
  voice?: FakeVoiceProvider;
  precio?: boolean;
  presupuesto?: boolean;
}

/** Duration of the WAV the fake voice writes: 16 kHz, 16-bit mono. */
const mideWav = async (file: string): Promise<number> => Math.round(((await readFile(file)).length - 44) / 32);

async function preparar(db: Db, o: Opciones = {}) {
  const locucion = o.locucion === undefined ? LOCUCION : o.locucion;
  const w = await producibleWorld(db, {
    formato: 'reel',
    clips: [CLIP],
    sceneSeconds: o.sceneSeconds ?? 5,
    sinCifras: true,
    vocesEnOff: o.voces ?? TEXTOS,
    perfilVoz: locucion === null ? {} : { locucion },
  });
  if (o.presupuesto !== false) await createTope(db, { clienteId: w.clienteId, montoTecho: '10' });
  if (o.precio !== false) await createPrecioModelo(db, { proveedor: 'fake_voice', modelo: 'fake-tts-model', unidad: 'caracteres', precioPorBloque: '0.08', tamanoBloque: 1000 });
  const voice = o.voice ?? new FakeVoiceProvider();
  const brief = (await getBriefActual(db, w.clienteId, w.piezaId))!;
  const args = (extra: Partial<PrepararVozArgs> = {}): PrepararVozArgs => ({
    db,
    storage: w.storage,
    voz: o.sinProveedor ? undefined : { provider: voice, measureAudio: mideWav },
    logger: createLogger('silent'),
    clienteId: w.clienteId,
    brief,
    piezaId: w.piezaId,
    instantePieza: new Date('2026-11-05T15:00:00Z'),
    perfilVoz: locucion === null ? {} : { locucion },
    hayPlantilla: o.plantilla !== false,
    actor: SISTEMA,
    ahora: new Date('2026-11-02T12:00:00Z'),
    ...extra,
  });
  const cuenta = async (tabla: string) => Number((await db.query(`SELECT count(*) AS n FROM ${tabla} WHERE cliente_id = $1`, [w.clienteId])).rows[0].n);
  return { w, voice, args, cuenta };
}

async function falla<T extends Error>(run: () => Promise<unknown>, type: new (...a: never[]) => T): Promise<T> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(type);
    return error as T;
  }
  throw new Error('expected a refusal');
}

describe('prepararVozDelReel: when there is no voice', () => {
  const casos: [string, Opciones, VozOmitida][] = [
    ['no voice in the profile', { locucion: null }, 'sin_configuracion'],
    ['a voice that is not enabled', { locucion: { ...LOCUCION, habilitada: false } }, 'sin_configuracion'],
    ['no provider in the process', { sinProveedor: true }, 'sin_proveedor'],
    ['no template to draw the subtitles', { plantilla: false }, 'sin_plantilla'],
    ['no scene has a voice-over text', { voces: [undefined, undefined, undefined] }, 'sin_texto'],
    ['only empty texts, even without a template', { voces: ['  ', '', undefined], plantilla: false }, 'sin_texto'],
  ];
  for (const [nombre, opciones, motivo] of casos) {
    it(`${nombre}: omitted as "${motivo}", with zero calls, no reservation and no cost`, async () => {
      await withTestTransaction(async (db) => {
        const { args, voice, cuenta } = await preparar(db, opciones);
        const r = await prepararVozDelReel(args());
        expect(r).toEqual({ voces: [], locuciones: [], omitida: motivo, llamadas: 0, costo: 0n });
        expect(voice.calls).toHaveLength(0);
        expect(await cuenta('autorizaciones_gasto')).toBe(0);
        expect(await cuenta('locuciones')).toBe(0);
      });
    });
  }

  it('an invalid voice block is an error naming the fields (nothing is spent)', async () => {
    await withTestTransaction(async (db) => {
      const { args, voice, cuenta } = await preparar(db, { locucion: { ...LOCUCION, velocidad: 9 } });
      const e = await falla(() => prepararVozDelReel(args()), ConfiguracionVozInvalidaError);
      expect(e.campos).toEqual(['velocidad']);
      expect(voice.calls).toHaveLength(0);
      expect(await cuenta('autorizaciones_gasto')).toBe(0);
    });
  });
});

describe('prepararVozDelReel: the free refusals come first', () => {
  it('a spoken figure that is not a verified fact: scene and reason, nothing spent', async () => {
    await withTestTransaction(async (db) => {
      const { args, voice, cuenta } = await preparar(db, { voces: ['Cada manana tostamos cafe', 'El cafe cuesta cuatro dolares hoy', undefined] });
      const e = await falla(() => prepararVozDelReel(args()), VozEscenaInvalidaError);
      expect(e.escena).toBe(2);
      expect(e.motivos).toContain('cifra_libre');
      expect(e.message).not.toContain('cafe');
      expect(voice.calls).toHaveLength(0);
      expect(await cuenta('autorizaciones_gasto')).toBe(0);
    });
  });

  it('a banned word of the client in the spoken text', async () => {
    await withTestTransaction(async (db) => {
      const { w, args, voice } = await preparar(db, { voces: ['Nuestro cafe es el mas barato', undefined, undefined] });
      await db.query(`INSERT INTO reglas_prohibidas (cliente_id, tipo, texto) VALUES ($1, 'palabra', 'barato')`, [w.clienteId]);
      const e = await falla(() => prepararVozDelReel(args()), VozEscenaInvalidaError);
      expect(e.motivos).toEqual(['regla_prohibida_palabra']);
      expect(voice.calls).toHaveLength(0);
    });
  });

  it('glyphs the subtitle font cannot draw', async () => {
    await withTestTransaction(async (db) => {
      const { args, voice } = await preparar(db, { voces: ['Hola 😀 amigos del cafe', undefined, undefined] });
      await falla(() => prepararVozDelReel(args()), UnsupportedGlyphsError);
      expect(voice.calls).toHaveLength(0);
    });
  });

  it('the lower bound: even the fastest speech does not fit, so nothing is paid (and ALL such scenes are listed)', async () => {
    await withTestTransaction(async (db) => {
      const largo = 'palabra '.repeat(30).trim(); // 239 characters: 9.96 s at the fastest speech, in a 5 s scene
      const { args, voice, cuenta } = await preparar(db, { voces: [largo, 'Texto corto del cafe', largo] });
      const e = await falla(() => prepararVozDelReel(args()), LocucionMasLargaQueEscenaError);
      expect(e.escenas.map((x) => x.escena)).toEqual([1, 3]);
      expect(voice.calls).toHaveLength(0);
      expect(await cuenta('autorizaciones_gasto')).toBe(0);
      expect(await cuenta('libro_gastos')).toBe(0);
    });
  });

  it('the reel length (15 to 30 s) is checked before paying', async () => {
    await withTestTransaction(async (db) => {
      const { args, voice, cuenta } = await preparar(db, { sceneSeconds: 4 });
      await falla(() => prepararVozDelReel(args()), DuracionReelFueraDeRangoError);
      expect(voice.calls).toHaveLength(0);
      expect(await cuenta('autorizaciones_gasto')).toBe(0);
    });
  });

  it('a scene with no valid duration', async () => {
    await withTestTransaction(async (db) => {
      const { args } = await preparar(db);
      const brief = args().brief;
      const sinDuracion = { ...brief, contenido: { ...brief.contenido, escenas: brief.contenido.escenas.map((e, i) => (i === 0 ? { ...e, duracion_s: undefined } : e)) } };
      await falla(() => prepararVozDelReel(args({ brief: sinDuracion })), LocucionEntradaInvalidaError);
    });
  });
});

describe('prepararVozDelReel: generating', () => {
  it('voices only the scenes with a text, returns the real word times and links, and pays once per distinct text', async () => {
    await withTestTransaction(async (db) => {
      const { args, voice, cuenta } = await preparar(db);
      const r = await prepararVozDelReel(args());
      expect(r.omitida).toBeNull();
      expect(r.llamadas).toBe(2);
      expect(voice.calls.map((c) => c.text)).toEqual([TEXTOS[0], TEXTOS[2]]);
      expect(r.voces.map((v) => v.escena)).toEqual([1, 3]);
      expect(r.locuciones.map((l) => l.escena)).toEqual([1, 3]);
      expect(r.costo).toBeGreaterThan(0n);

      const v = r.voces[0]!;
      expect(v.texto).toBe(TEXTOS[0]);
      expect(v.entradaMs).toBe(150);
      expect(v.tiempos.map((t) => t.palabra)).toEqual(TEXTOS[0]!.split(' '));
      expect(v.tiempos[0]!.inicioMs).toBe(150); // the lead-in, from the first spoken character
      expect(v.tiempos.at(-1)!.finMs).toBe(5000); // the last word holds until the end of the scene
      expect(v.clave).toMatch(/^[0-9a-f-]{36}\/locuciones\/[0-9a-f]{64}\.wav$/);
      expect(await cuenta('locuciones')).toBe(2);

      // Again: everything comes from the cache.
      const otra = await prepararVozDelReel(args());
      expect(otra.llamadas).toBe(0);
      expect(otra.costo).toBe(0n);
      expect(voice.calls).toHaveLength(2);
      expect(otra.locuciones).toEqual(r.locuciones);
      expect(await cuenta('libro_gastos')).toBe(2);
    });
  });

  it('two scenes with the same text share one voice-over', async () => {
    await withTestTransaction(async (db) => {
      const { args, voice } = await preparar(db, { voces: ['Cada manana tostamos cafe', undefined, 'Cada manana tostamos cafe'] });
      const r = await prepararVozDelReel(args());
      expect(voice.calls).toHaveLength(1);
      expect(r.llamadas).toBe(1);
      expect(r.locuciones[0]!.locucionId).toBe(r.locuciones[1]!.locucionId);
    });
  });

  it('a voice that only turns out too long once measured is refused with a typed error (it was paid and stays cached)', async () => {
    await withTestTransaction(async (db) => {
      // 59 characters at 100 ms is 5.9 s: it passes the free bound (2.5 s) and does not fit a 5 s scene.
      const largo = 'Cada manana tostamos cafe de origen y lo servimos con calma';
      const { args, voice, cuenta } = await preparar(db, { voces: [largo, undefined, undefined], voice: new FakeVoiceProvider({ msPerChar: 100 }) });
      const e = await falla(() => prepararVozDelReel(args()), LocucionMasLargaQueEscenaError);
      expect(e.escenas).toHaveLength(1);
      expect(e.escenas[0]!.escena).toBe(1);
      expect(voice.calls).toHaveLength(1);
      expect(await cuenta('libro_gastos')).toBe(1);
      expect(await cuenta('locuciones')).toBe(1);
    });
  });

  it('without a price in characters or without budget: refused with zero calls', async () => {
    await withTestTransaction(async (db) => {
      const sinPrecio = await preparar(db, { precio: false });
      await expect(prepararVozDelReel(sinPrecio.args())).rejects.toMatchObject({ name: 'PriceNotFoundError' });
      expect(sinPrecio.voice.calls).toHaveLength(0);
    });
    await withTestTransaction(async (db) => {
      const sinPresupuesto = await preparar(db, { presupuesto: false });
      await expect(prepararVozDelReel(sinPresupuesto.args())).rejects.toMatchObject({ name: 'BudgetRefusedError' });
      expect(sinPresupuesto.voice.calls).toHaveLength(0);
    });
  });

  it('logs hold counts and ids, never the spoken text', async () => {
    await withTestTransaction(async (db) => {
      const lineas: string[] = [];
      const logger = createLogger('debug', { write: (l: string) => void lineas.push(l) });
      const { args } = await preparar(db);
      await prepararVozDelReel(args({ logger }));
      const todo = lineas.join('');
      expect(todo).toContain('reel voice-over ready');
      for (const palabra of ['tostamos', 'cafe de origen', 'Pasa por']) expect(todo, palabra).not.toContain(palabra);
    });
  });
});
