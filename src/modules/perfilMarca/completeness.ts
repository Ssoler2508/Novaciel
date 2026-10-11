// Brand profile completeness (spec section 4.2, items marked (O), and section 4.3).
//
// IMPORTANT: the JSON keys below (for example `nombre_comercial` or `colores.principal`) are a
// PROPOSAL pending confirmation by the Senior. The specification names the profile blocks and says
// what each one holds, but it does not define the keys inside them.
//
// Everything that decides "complete" is data in this file; computeCompleteness is pure (no database,
// no I/O). `origen` records where each requirement comes from: an (O) item of section 4.2, or a
// system requirement that is not in the questionnaire.

export const PERFIL_JSON_BLOCKS = [
  'identidad',
  'restricciones_sector',
  'audiencia',
  'voz',
  'pilares',
  'kit_visual',
  'objetivo',
  'operacion',
  'plan',
] as const;

export type PerfilJsonBlock = (typeof PERFIL_JSON_BLOCKS)[number];

/** Blocks reported by computeCompleteness: the nine JSONB blocks, the language column and the three table-backed blocks. */
export type CompletenessBlock = PerfilJsonBlock | 'idioma_contenido' | 'hechos_verificados' | 'prohibido' | 'personas';

export type FieldKind = 'string' | 'array' | 'boolean' | 'number' | 'oneOf';

export type Origen = { tipo: 'O'; items: readonly number[] } | { tipo: 'sistema' };

/** The requirement only counts when the value at `path` (from the profile root) equals `equals`. */
export interface Condition {
  path: string;
  equals: unknown;
}

export interface FieldRequirement {
  /** Path inside the block (dot-separated). For `idioma_contenido` it is read from the profile root. */
  path: string;
  kind: FieldKind;
  /** Allowed values when kind is `oneOf`. */
  values?: readonly string[];
  origen: Origen;
  when?: Condition;
}

const O = (...items: number[]): Origen => ({ tipo: 'O', items });
const SISTEMA: Origen = { tipo: 'sistema' };

export const REQUIRED_FIELDS: Record<PerfilJsonBlock | 'idioma_contenido', readonly FieldRequirement[]> = {
  identidad: [
    { path: 'nombre_comercial', kind: 'string', origen: O(1) },
    { path: 'razon_social', kind: 'string', origen: O(1) },
    { path: 'escritura_marca', kind: 'string', origen: O(1) },
    { path: 'descripcion', kind: 'string', origen: O(2) },
    { path: 'productos', kind: 'array', origen: O(3) },
    { path: 'productos_rentables', kind: 'array', origen: O(4) },
    { path: 'productos_a_impulsar', kind: 'array', origen: O(5) },
    { path: 'ubicacion', kind: 'string', origen: O(6) },
    { path: 'zonas', kind: 'array', origen: O(6) },
    { path: 'modalidades_atencion', kind: 'array', origen: O(6) },
  ],
  restricciones_sector: [
    { path: 'sector', kind: 'string', origen: O(64) },
    { path: 'tiene_restricciones', kind: 'boolean', origen: O(64) },
    {
      path: 'restricciones',
      kind: 'array',
      origen: O(64),
      when: { path: 'restricciones_sector.tiene_restricciones', equals: true },
    },
  ],
  audiencia: [
    { path: 'segmentos', kind: 'array', origen: O(17) },
    { path: 'problemas', kind: 'array', origen: O(18) },
    { path: 'preguntas_frecuentes', kind: 'array', origen: O(19) },
    { path: 'objeciones', kind: 'array', origen: O(20) },
  ],
  voz: [
    { path: 'adjetivos', kind: 'array', origen: O(26) },
    { path: 'adjetivos_nunca', kind: 'array', origen: O(27) },
    { path: 'trato', kind: 'string', origen: O(28) },
    { path: 'frases_propias', kind: 'array', origen: O(29) },
    { path: 'emojis', kind: 'string', origen: O(31) },
    { path: 'usa_humor', kind: 'boolean', origen: O(31) },
  ],
  pilares: [
    { path: 'temas', kind: 'array', origen: O(37) },
    { path: 'percepcion_deseada', kind: 'string', origen: O(36) },
  ],
  kit_visual: [
    { path: 'aparecen_personas', kind: 'boolean', origen: O(51) },
    { path: 'logo_claro', kind: 'string', origen: O(41) },
    { path: 'logo_oscuro', kind: 'string', origen: O(41) },
    { path: 'colores.principal', kind: 'string', origen: O(42) },
    { path: 'colores.secundarios', kind: 'array', origen: O(42) },
    { path: 'colores.acento', kind: 'string', origen: O(42) },
    { path: 'tipografia_titulos', kind: 'string', origen: O(43) },
    { path: 'tipografia_texto', kind: 'string', origen: O(43) },
    { path: 'estilo_imagen.luminosidad', kind: 'string', origen: O(45) },
    { path: 'estilo_imagen.temperatura', kind: 'string', origen: O(45) },
    { path: 'estilo_imagen.limpieza', kind: 'string', origen: O(45) },
    { path: 'estilo_imagen.produccion', kind: 'string', origen: O(45) },
    { path: 'plantilla_subtitulos', kind: 'string', origen: O(46) },
  ],
  objetivo: [
    { path: 'objetivo_90_dias', kind: 'string', origen: O(12) },
    { path: 'medicion_actual', kind: 'string', origen: O(13) },
    { path: 'canal_contacto', kind: 'string', origen: O(7) },
    { path: 'contacto_destino', kind: 'string', origen: O(7) },
  ],
  operacion: [
    { path: 'aprobador.nombre', kind: 'string', origen: O(79) },
    { path: 'aprobador.cargo', kind: 'string', origen: O(79) },
    { path: 'aprobador.whatsapp', kind: 'string', origen: O(79) },
    { path: 'aprobador.correo', kind: 'string', origen: O(79) },
    { path: 'aprobador_suplente.nombre', kind: 'string', origen: O(80) },
    { path: 'aprobador_suplente.correo', kind: 'string', origen: O(80) },
    { path: 'dias_revision', kind: 'array', origen: O(81) },
    { path: 'horas_revision', kind: 'string', origen: O(81) },
    { path: 'tiempo_respuesta_horas', kind: 'number', origen: O(81) },
    { path: 'plan_aprobado_por', kind: 'string', origen: O(83) },
    { path: 'plataformas', kind: 'array', origen: O(72, 73) },
    { path: 'plataforma_prioritaria', kind: 'string', origen: O(73) },
    { path: 'tipo_cuenta', kind: 'string', origen: O(74) },
    // IANA name, for example America/New_York. Needed by scheduling; not an (O) item.
    { path: 'zona_horaria', kind: 'string', origen: SISTEMA },
  ],
  // No (O) item: nothing is required, the block always reports 100.
  plan: [],
  idioma_contenido: [{ path: 'idioma_contenido', kind: 'oneOf', values: ['es', 'en', 'ambos'], origen: O(28) }],
};

export type HechoTipoKey = 'precio' | 'horario' | 'promocion' | 'cifra' | 'otro';

export type TableSource =
  | { fuente: 'hechos'; tipo: HechoTipoKey }
  | { fuente: 'reglas' }
  | { fuente: 'autorizaciones' };

export interface TableRequirement {
  /** Name listed in `missing` when the requirement is not met. */
  id: string;
  source: TableSource;
  /** Minimum number of valid rows. */
  min: number;
  origen: Origen;
  when?: Condition;
}

export const TABLE_REQUIREMENTS: Record<'hechos_verificados' | 'prohibido' | 'personas', readonly TableRequirement[]> = {
  hechos_verificados: [
    { id: 'precio', source: { fuente: 'hechos', tipo: 'precio' }, min: 1, origen: O(3) },
    { id: 'horario', source: { fuente: 'hechos', tipo: 'horario' }, min: 1, origen: O(6) },
  ],
  prohibido: [{ id: 'regla', source: { fuente: 'reglas' }, min: 1, origen: O(30, 62) }],
  personas: [
    {
      id: 'autorizacion_valida',
      source: { fuente: 'autorizaciones' },
      min: 1,
      origen: O(51, 52, 53),
      when: { path: 'kit_visual.aparecen_personas', equals: true },
    },
  ],
};

/** Blocks that must be at 100% before a client can be planned. Every block with required fields is here. */
export const MANDATORY_BLOCKS: readonly CompletenessBlock[] = [
  'identidad',
  'restricciones_sector',
  'audiencia',
  'voz',
  'pilares',
  'kit_visual',
  'objetivo',
  'operacion',
  'idioma_contenido',
  'hechos_verificados',
  'prohibido',
  'personas',
];

export const ALL_BLOCKS: readonly CompletenessBlock[] = [
  ...PERFIL_JSON_BLOCKS,
  'idioma_contenido',
  'hechos_verificados',
  'prohibido',
  'personas',
];

export interface ProfileSnapshot {
  perfil: Record<PerfilJsonBlock, Record<string, unknown>> & { idioma_contenido: string | null };
  /** Valid (in force) facts of the client, counted by tipo. */
  hechosValidosPorTipo: Record<HechoTipoKey, number>;
  /** Banned rules of the client. */
  reglasProhibidas: number;
  /** Valid authorizations: in force, not revoked, not a minor. */
  autorizacionesValidas: number;
}

export interface BlockCompleteness {
  /** 0-100. Never 100 while something is missing. */
  percent: number;
  /** Missing JSON paths, or requirement ids for the table-backed blocks. */
  missing: string[];
  mandatory: boolean;
}

export interface CompletenessResult {
  blocks: Record<CompletenessBlock, BlockCompleteness>;
  /** True when every mandatory block is at 100%. */
  mandatoryComplete: boolean;
}

export function readPath(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function isFilled(value: unknown, requirement: Pick<FieldRequirement, 'kind' | 'values'>): boolean {
  switch (requirement.kind) {
    case 'string':
      return typeof value === 'string' && value.trim() !== '';
    case 'array':
      return Array.isArray(value) && value.length >= 1;
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'oneOf':
      return typeof value === 'string' && (requirement.values ?? []).includes(value);
  }
}

function conditionHolds(condition: Condition | undefined, perfil: ProfileSnapshot['perfil']): boolean {
  return condition === undefined || readPath(perfil, condition.path) === condition.equals;
}

function score(activeCount: number, missing: string[], mandatory: boolean): BlockCompleteness {
  if (activeCount === 0 || missing.length === 0) return { percent: 100, missing, mandatory };
  const percent = Math.min(99, Math.round(((activeCount - missing.length) / activeCount) * 100));
  return { percent, missing, mandatory };
}

function validCount(snapshot: ProfileSnapshot, source: TableSource): number {
  switch (source.fuente) {
    case 'hechos':
      return snapshot.hechosValidosPorTipo[source.tipo];
    case 'reglas':
      return snapshot.reglasProhibidas;
    case 'autorizaciones':
      return snapshot.autorizacionesValidas;
  }
}

/** Pure: percentage of required fields filled (0-100) and the missing ones, per block. */
export function computeCompleteness(snapshot: ProfileSnapshot): CompletenessResult {
  const blocks = {} as Record<CompletenessBlock, BlockCompleteness>;
  const isMandatory = (block: CompletenessBlock) => MANDATORY_BLOCKS.includes(block);

  for (const block of [...PERFIL_JSON_BLOCKS, 'idioma_contenido'] as const) {
    const active = REQUIRED_FIELDS[block].filter((req) => conditionHolds(req.when, snapshot.perfil));
    const root = block === 'idioma_contenido' ? snapshot.perfil : snapshot.perfil[block];
    const missing = active.filter((req) => !isFilled(readPath(root, req.path), req)).map((req) => req.path);
    blocks[block] = score(active.length, missing, isMandatory(block));
  }

  for (const block of ['hechos_verificados', 'prohibido', 'personas'] as const) {
    const active = TABLE_REQUIREMENTS[block].filter((req) => conditionHolds(req.when, snapshot.perfil));
    const missing = active.filter((req) => validCount(snapshot, req.source) < req.min).map((req) => req.id);
    blocks[block] = score(active.length, missing, isMandatory(block));
  }

  const mandatoryComplete = MANDATORY_BLOCKS.every((block) => blocks[block].percent === 100);
  return { blocks, mandatoryComplete };
}
