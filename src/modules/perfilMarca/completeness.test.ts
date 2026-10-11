import { describe, expect, it } from 'vitest';
import { completeSnapshot, emptySnapshot } from '../../../tests/utils/completeProfile.js';
import {
  ALL_BLOCKS,
  MANDATORY_BLOCKS,
  PERFIL_JSON_BLOCKS,
  REQUIRED_FIELDS,
  TABLE_REQUIREMENTS,
  computeCompleteness,
  type CompletenessBlock,
  type ProfileSnapshot,
} from './completeness.js';

const result = (snapshot: ProfileSnapshot) => computeCompleteness(snapshot);

describe('computeCompleteness: empty and complete profiles', () => {
  it('an empty profile scores 0% on every mandatory block that has required fields', () => {
    const { blocks, mandatoryComplete } = result(emptySnapshot());
    for (const block of MANDATORY_BLOCKS) {
      // personas has nothing to require until aparecen_personas is true.
      if (block === 'personas') continue;
      expect(blocks[block].percent, block).toBe(0);
      expect(blocks[block].missing.length, block).toBeGreaterThan(0);
    }
    expect(mandatoryComplete).toBe(false);
  });

  it('plan has no required fields and always reports 100, not mandatory', () => {
    const { blocks } = result(emptySnapshot());
    expect(blocks.plan).toEqual({ percent: 100, missing: [], mandatory: false });
    expect(REQUIRED_FIELDS.plan).toEqual([]);
  });

  it('a complete profile scores 100% on every block', () => {
    const { blocks, mandatoryComplete } = result(completeSnapshot());
    for (const block of ALL_BLOCKS) {
      expect(blocks[block].percent, block).toBe(100);
      expect(blocks[block].missing, block).toEqual([]);
    }
    expect(mandatoryComplete).toBe(true);
  });

  it('reports every block with the right mandatory flag', () => {
    const { blocks } = result(completeSnapshot());
    expect(Object.keys(blocks).sort()).toEqual([...ALL_BLOCKS].sort());
    for (const block of ALL_BLOCKS) expect(blocks[block].mandatory).toBe(block !== 'plan');
  });
});

describe('what counts as filled', () => {
  const withVoz = (patch: Record<string, unknown>) => {
    const snapshot = completeSnapshot();
    snapshot.perfil.voz = { ...snapshot.perfil.voz, ...patch };
    return result(snapshot).blocks.voz;
  };

  it.each([
    ['blank string', { trato: '   ' }, 'trato'],
    ['empty string', { trato: '' }, 'trato'],
    ['non-string where a string is needed', { trato: 5 }, 'trato'],
    ['null', { trato: null }, 'trato'],
    ['empty array', { adjetivos: [] }, 'adjetivos'],
    ['string where an array is needed', { adjetivos: 'cercana' }, 'adjetivos'],
    ['string where a boolean is needed', { usa_humor: 'si' }, 'usa_humor'],
  ])('%s is not filled', (_name, patch, path) => {
    const block = withVoz(patch);
    expect(block.missing).toEqual([path]);
    expect(block.percent).toBeLessThan(100);
  });

  it('false counts as a set boolean', () => {
    expect(withVoz({ usa_humor: false })).toMatchObject({ percent: 100, missing: [] });
  });

  it('0 counts as a set number, NaN does not', () => {
    const operacion = (value: unknown) => {
      const snapshot = completeSnapshot();
      snapshot.perfil.operacion = { ...snapshot.perfil.operacion, tiempo_respuesta_horas: value };
      return result(snapshot).blocks.operacion;
    };
    expect(operacion(0)).toMatchObject({ percent: 100 });
    expect(operacion(Number.NaN).missing).toEqual(['tiempo_respuesta_horas']);
    expect(operacion('24').missing).toEqual(['tiempo_respuesta_horas']);
  });

  it('reads nested paths and lists the exact missing path', () => {
    const snapshot = completeSnapshot();
    snapshot.perfil.kit_visual = { ...snapshot.perfil.kit_visual, colores: { principal: '#000000', secundarios: [] } };
    expect(result(snapshot).blocks.kit_visual.missing.sort()).toEqual(['colores.acento', 'colores.secundarios']);
  });

  it('is never 100 while a field is missing, even with many fields', () => {
    const snapshot = completeSnapshot();
    snapshot.perfil.operacion = { ...snapshot.perfil.operacion, zona_horaria: '' };
    const operacion = result(snapshot).blocks.operacion;
    expect(operacion.missing).toEqual(['zona_horaria']);
    expect(operacion.percent).toBe(93);
    expect(operacion.percent).toBeLessThan(100);
  });

  it('computes the percentage from filled / required fields', () => {
    const snapshot = emptySnapshot();
    snapshot.perfil.pilares = { temas: [{ nombre: 'Café', peso: 100 }] };
    expect(result(snapshot).blocks.pilares).toMatchObject({ percent: 50, missing: ['percepcion_deseada'] });
  });
});

describe('idioma_contenido', () => {
  it.each([['es'], ['en'], ['ambos']])('accepts %s', (idioma) => {
    const snapshot = completeSnapshot();
    snapshot.perfil.idioma_contenido = idioma;
    expect(result(snapshot).blocks.idioma_contenido.percent).toBe(100);
  });

  it.each([[null], [''], ['fr']])('rejects %s', (idioma) => {
    const snapshot = completeSnapshot();
    snapshot.perfil.idioma_contenido = idioma;
    expect(result(snapshot).blocks.idioma_contenido).toMatchObject({ percent: 0, missing: ['idioma_contenido'] });
  });
});

describe('conditional requirements', () => {
  it('restricciones counts only when tiene_restricciones is true', () => {
    const base = completeSnapshot();
    const withRestricciones = (tiene: unknown, restricciones: unknown) => {
      const snapshot = structuredClone(base);
      snapshot.perfil.restricciones_sector = { sector: 'alimentos', tiene_restricciones: tiene, restricciones };
      return result(snapshot).blocks.restricciones_sector;
    };
    expect(withRestricciones(true, [])).toMatchObject({ percent: 67, missing: ['restricciones'] });
    expect(withRestricciones(true, ['x'])).toMatchObject({ percent: 100 });
    expect(withRestricciones(false, [])).toMatchObject({ percent: 100, missing: [] });
  });
});

describe('hechos_verificados', () => {
  const hechos = (precio: number, horario: number, resto = 0) => {
    const snapshot = completeSnapshot();
    snapshot.hechosValidosPorTipo = { precio, horario, promocion: resto, cifra: resto, otro: resto };
    return result(snapshot).blocks.hechos_verificados;
  };

  it('needs a valid precio and a valid horario', () => {
    expect(hechos(1, 1)).toMatchObject({ percent: 100, missing: [] });
  });

  it('only a precio is incomplete with horario missing', () => {
    expect(hechos(1, 0)).toMatchObject({ percent: 50, missing: ['horario'] });
  });

  it('only a horario is incomplete with precio missing', () => {
    expect(hechos(0, 1)).toMatchObject({ percent: 50, missing: ['precio'] });
  });

  it('promocion, cifra and otro do not satisfy it', () => {
    expect(hechos(0, 0, 5)).toMatchObject({ percent: 0, missing: ['precio', 'horario'] });
  });
});

describe('prohibido', () => {
  it('needs at least one rule', () => {
    const snapshot = completeSnapshot();
    snapshot.reglasProhibidas = 0;
    expect(result(snapshot).blocks.prohibido).toMatchObject({ percent: 0, missing: ['regla'] });
    snapshot.reglasProhibidas = 1;
    expect(result(snapshot).blocks.prohibido.percent).toBe(100);
  });
});

describe('personas depends on kit_visual.aparecen_personas', () => {
  const personas = (aparecen: unknown, autorizaciones: number) => {
    const snapshot = completeSnapshot();
    snapshot.perfil.kit_visual = { ...snapshot.perfil.kit_visual, aparecen_personas: aparecen };
    snapshot.autorizacionesValidas = autorizaciones;
    return result(snapshot);
  };

  it('false with 0 authorizations is complete', () => {
    const r = personas(false, 0);
    expect(r.blocks.personas).toMatchObject({ percent: 100, missing: [] });
    expect(r.mandatoryComplete).toBe(true);
  });

  it('true with 0 authorizations is incomplete', () => {
    const r = personas(true, 0);
    expect(r.blocks.personas).toMatchObject({ percent: 0, missing: ['autorizacion_valida'] });
    expect(r.mandatoryComplete).toBe(false);
  });

  it('true with 1 valid authorization is complete', () => {
    expect(personas(true, 1).blocks.personas.percent).toBe(100);
  });

  it('when aparecen_personas is not set, kit_visual is incomplete and personas requires nothing', () => {
    const r = personas(undefined, 0);
    expect(r.blocks.kit_visual.missing).toEqual(['aparecen_personas']);
    expect(r.blocks.personas.percent).toBe(100);
    expect(r.mandatoryComplete).toBe(false);
  });
});

describe('the definitions', () => {
  it('only describe known blocks, and every block with required fields is mandatory', () => {
    expect(Object.keys(REQUIRED_FIELDS).sort()).toEqual([...PERFIL_JSON_BLOCKS, 'idioma_contenido'].sort());
    expect(Object.keys(TABLE_REQUIREMENTS).sort()).toEqual(['hechos_verificados', 'personas', 'prohibido']);
    const withRequirements: CompletenessBlock[] = [
      ...PERFIL_JSON_BLOCKS.filter((b) => REQUIRED_FIELDS[b].length > 0),
      'idioma_contenido',
      'hechos_verificados',
      'prohibido',
      'personas',
    ];
    expect([...MANDATORY_BLOCKS].sort()).toEqual([...withRequirements].sort());
  });

  it('zona_horaria is a system requirement, not an (O) item', () => {
    const zona = REQUIRED_FIELDS.operacion.find((r) => r.path === 'zona_horaria');
    expect(zona?.origen).toEqual({ tipo: 'sistema' });
    for (const requirement of Object.values(REQUIRED_FIELDS).flat()) {
      if (requirement.path !== 'zona_horaria') expect(requirement.origen.tipo).toBe('O');
    }
  });

  it('is pure: it does not modify the snapshot', () => {
    const snapshot = completeSnapshot();
    const copy = structuredClone(snapshot);
    computeCompleteness(snapshot);
    expect(snapshot).toEqual(copy);
  });
});
