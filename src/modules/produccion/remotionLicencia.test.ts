import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/index.js';
import { FakeCapaTextoAnimado, PATRON_CAPA, nombreFotogramaCapa } from './capaTexto.js';
import { CapaTextoError, RemotionLicenciaNoConfiguradaError, RemotionNoDisponibleError } from './errors.js';
import { elegirPlantilla, FORMATO_ID_PLANTILLA, getPlantilla, PLANTILLA_POR_TRABAJO, PLANTILLAS, ultimaVersion } from './plantillas.js';
import { exigirLicenciaRemotion, licenciaRemotion, remotionHabilitado, SUPUESTO_LICENCIA } from './remotionLicencia.js';

const key = Buffer.alloc(32, 1).toString('base64');
const baseEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  LOG_LEVEL: 'info',
  LOCAL_STORAGE_SIGNING_SECRET: 'x'.repeat(32),
  SECRETS_KEYS: `1:${key}`,
  SECRETS_ACTIVE_KEY_VERSION: '1',
};

describe('REMOTION_LICENCIA (the license gate)', () => {
  it('has no default: unset, or empty as copied from .env.example, means Remotion is disabled', () => {
    expect(loadConfig(baseEnv).remotion.licencia).toBeUndefined();
    expect(loadConfig({ ...baseEnv, REMOTION_LICENCIA: '' }).remotion.licencia).toBeUndefined();
  });

  it('accepts exactly "gratuita" and "empresa"', () => {
    expect(loadConfig({ ...baseEnv, REMOTION_LICENCIA: 'gratuita' }).remotion.licencia).toBe('gratuita');
    expect(loadConfig({ ...baseEnv, REMOTION_LICENCIA: 'empresa' }).remotion.licencia).toBe('empresa');
    for (const bad of ['Gratuita', 'EMPRESA', 'free', 'si', 'true', '1', ' gratuita', 'gratuita ']) {
      expect(() => loadConfig({ ...baseEnv, REMOTION_LICENCIA: bad }), bad).toThrow(/REMOTION_LICENCIA/);
    }
  });

  it('is documented in .env.example (never .env), with no value filled in', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    expect(example).toMatch(/^REMOTION_LICENCIA=$/m);
    expect(example).toContain('docs/ADR-06_REMOTION_LICENCIA.md');
    expect(example).toMatch(/gratuita/);
    expect(example).toMatch(/empresa/);
    expect(example).toMatch(/NO default/);
  });

  it('exigirLicenciaRemotion refuses with a typed error when unset, and returns the declaration otherwise', () => {
    const sin = loadConfig(baseEnv);
    expect(licenciaRemotion(sin)).toBeUndefined();
    expect(remotionHabilitado(sin)).toBe(false);
    expect(() => exigirLicenciaRemotion(sin)).toThrow(RemotionLicenciaNoConfiguradaError);
    const gratuita = loadConfig({ ...baseEnv, REMOTION_LICENCIA: 'gratuita' });
    expect(remotionHabilitado(gratuita)).toBe(true);
    expect(exigirLicenciaRemotion(gratuita)).toBe('gratuita');
    expect(exigirLicenciaRemotion(loadConfig({ ...baseEnv, REMOTION_LICENCIA: 'empresa' }))).toBe('empresa');
  });

  it('the typed errors name the cause and never carry text', () => {
    expect(new RemotionLicenciaNoConfiguradaError().message).toContain('REMOTION_LICENCIA');
    expect(new RemotionNoDisponibleError('navegador_ausente')).toMatchObject({ name: 'RemotionNoDisponibleError', razon: 'navegador_ausente' });
    expect(new CapaTextoError('tiempo_agotado')).toMatchObject({ name: 'CapaTextoError', razon: 'tiempo_agotado' });
  });

  it('the assumption behind "gratuita" is written down in one place, with the date and the ADR', () => {
    expect(SUPUESTO_LICENCIA.supuesto).toMatch(/at most 3 people/);
    expect(SUPUESTO_LICENCIA.verificadoEl).toBe('2026-10-21');
    const adr = readFileSync(new URL(`../../../${SUPUESTO_LICENCIA.adr}`, import.meta.url), 'utf8');
    expect(adr).toMatch(/Remotion/);
  });
});

describe('the template registry', () => {
  it('has unique ids with positive versions that the database accepts', () => {
    const ids = PLANTILLAS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PLANTILLAS.length).toBeGreaterThanOrEqual(2);
    for (const p of PLANTILLAS) {
      expect(FORMATO_ID_PLANTILLA.test(p.id), p.id).toBe(true);
      expect(Number.isInteger(p.version) && p.version >= 1, p.id).toBe(true);
      expect(p.descripcion.length).toBeGreaterThan(10);
    }
    expect(getPlantilla('barra_inferior', 1)).toMatchObject({ id: 'barra_inferior', version: 1 });
    expect(getPlantilla('barra_inferior', 99)).toBeUndefined();
    expect(getPlantilla('no_existe')).toBeUndefined();
    expect(ultimaVersion('titulo_y_palabras')).toMatchObject({ escenaTitulo: true });
  });

  it('every default by "trabajo" is a real template', () => {
    for (const id of Object.values(PLANTILLA_POR_TRABAJO)) expect(ultimaVersion(id), id).toBeDefined();
  });
});

describe('elegirPlantilla: who picks the template is the code', () => {
  const kit = (plantilla_subtitulos?: unknown) => ({ plantilla_subtitulos });

  it('with no license declared, no template is picked (Remotion is disabled)', () => {
    for (const trabajo of ['atraer', 'confianza', 'accion'] as const) {
      expect(elegirPlantilla({ licencia: undefined, kitVisual: kit('barra_inferior'), trabajo })).toBeNull();
    }
  });

  it('picks by the "trabajo" of the piece when the client names no registry template', () => {
    for (const licencia of ['gratuita', 'empresa'] as const) {
      expect(elegirPlantilla({ licencia, kitVisual: kit(), trabajo: 'atraer' })?.id).toBe('titulo_y_palabras');
      expect(elegirPlantilla({ licencia, kitVisual: kit(), trabajo: 'confianza' })?.id).toBe('barra_inferior');
      expect(elegirPlantilla({ licencia, kitVisual: kit(), trabajo: 'accion' })?.id).toBe('palabra_a_palabra');
    }
  });

  it('the seed value "plantilla-2" and other unknown names are ignored; garbage in kit_visual does not break it', () => {
    for (const kitVisual of [kit('plantilla-2'), kit(7), kit(null), kit('../etc/passwd'), null, undefined, 'texto', 42, []]) {
      expect(elegirPlantilla({ licencia: 'gratuita', kitVisual, trabajo: 'accion' })?.id).toBe('palabra_a_palabra');
    }
  });

  it("the client's own default wins when it names a registry template, at its latest version", () => {
    const elegida = elegirPlantilla({ licencia: 'gratuita', kitVisual: kit('barra_inferior'), trabajo: 'atraer' });
    expect(elegida).toMatchObject({ id: 'barra_inferior', version: ultimaVersion('barra_inferior')!.version });
  });
});

describe('the CapaTextoAnimado port (with its fake)', () => {
  const entrada = { plantilla: 'barra_inferior', version: 1, props: {}, ancho: 64, alto: 112, fps: 30, fotogramas: 5 };

  it('writes one transparent PNG per frame with the agreed names, in a folder the caller owns', async () => {
    const carpeta = await mkdtemp(path.join(os.tmpdir(), 'novaciel-capa-test-'));
    try {
      const fake = new FakeCapaTextoAnimado();
      const capa = await fake.renderizar(entrada, { carpeta, timeoutMs: 1000 });
      expect(capa).toEqual({ carpeta, patron: PATRON_CAPA, fotogramas: 5, ancho: 64, alto: 112 });
      expect((await readdir(carpeta)).sort()).toEqual([0, 1, 2, 3, 4].map(nombreFotogramaCapa));
      expect(nombreFotogramaCapa(12)).toBe('capa-00012.png');
      expect(fake.llamadas).toEqual([entrada]);
    } finally {
      await rm(carpeta, { recursive: true, force: true });
    }
  });

  it('fails with a typed error for an impossible frame count, and can be told to fail (failure policy tests)', async () => {
    const carpeta = await mkdtemp(path.join(os.tmpdir(), 'novaciel-capa-test-'));
    try {
      const fake = new FakeCapaTextoAnimado();
      await expect(fake.renderizar({ ...entrada, fotogramas: 0 }, { carpeta, timeoutMs: 1000 })).rejects.toMatchObject({ name: 'CapaTextoError', razon: 'entrada_invalida' });
      fake.fallarCon = new CapaTextoError('fallo_de_render');
      await expect(fake.renderizar(entrada, { carpeta, timeoutMs: 1000 })).rejects.toBeInstanceOf(CapaTextoError);
      expect(await readdir(carpeta)).toEqual([]);
    } finally {
      await rm(carpeta, { recursive: true, force: true });
    }
  });
});
