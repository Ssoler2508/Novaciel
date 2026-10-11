import {
  PERFIL_JSON_BLOCKS,
  REQUIRED_FIELDS,
  type FieldRequirement,
  type PerfilJsonBlock,
  type ProfileSnapshot,
} from '../../src/modules/perfilMarca/completeness.js';

function sampleValue(requirement: FieldRequirement): unknown {
  switch (requirement.kind) {
    case 'string':
      return 'valor ficticio';
    case 'array':
      return ['elemento ficticio'];
    case 'boolean':
      return true;
    case 'number':
      return 24;
    case 'oneOf':
      return requirement.values![0];
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    current[key] ??= {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

/** One JSONB block with every required field filled, generated from the definitions. */
export function completeBlock(block: PerfilJsonBlock): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const requirement of REQUIRED_FIELDS[block]) setPath(out, requirement.path, sampleValue(requirement));
  return out;
}

export function completeBlocks(): Record<PerfilJsonBlock, Record<string, unknown>> {
  return Object.fromEntries(PERFIL_JSON_BLOCKS.map((b) => [b, completeBlock(b)])) as Record<PerfilJsonBlock, Record<string, unknown>>;
}

export function emptyBlocks(): Record<PerfilJsonBlock, Record<string, unknown>> {
  return Object.fromEntries(PERFIL_JSON_BLOCKS.map((b) => [b, {}])) as Record<PerfilJsonBlock, Record<string, unknown>>;
}

/** A snapshot where everything mandatory is complete. */
export function completeSnapshot(): ProfileSnapshot {
  return {
    perfil: { ...completeBlocks(), idioma_contenido: 'es' },
    hechosValidosPorTipo: { precio: 1, horario: 1, promocion: 0, cifra: 0, otro: 0 },
    reglasProhibidas: 1,
    autorizacionesValidas: 1,
  };
}

/** A snapshot with nothing filled. */
export function emptySnapshot(): ProfileSnapshot {
  return {
    perfil: { ...emptyBlocks(), idioma_contenido: null },
    hechosValidosPorTipo: { precio: 0, horario: 0, promocion: 0, cifra: 0, otro: 0 },
    reglasProhibidas: 0,
    autorizacionesValidas: 0,
  };
}
