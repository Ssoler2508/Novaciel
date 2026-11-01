// The piece states and transitions of spec section 15 ("Estados de una pieza"). The database holds
// the same list (transiciones_pieza) and enforces it with a trigger; this copy lets the service
// reject an invalid transition before touching the database. A test asserts both agree exactly.

export const ESTADOS = [
  'planeada',
  'plan_aprobado',
  'guion_listo',
  'en_produccion',
  'en_control_calidad',
  'revision_novaciel',
  'esperando_aprobacion',
  'aprobada',
  'programada',
  'publicada',
  'en_medicion',
  'cerrada',
  'con_cambios',
  'rechazada',
  'fallo_publicacion',
  'pausada',
] as const;
export type EstadoPieza = (typeof ESTADOS)[number];

/** No transition leaves these, and they cannot be paused. */
export const TERMINAL_ESTADOS: readonly EstadoPieza[] = ['cerrada', 'rechazada'];

/** Every state that can be paused: all but the terminal ones and `pausada` itself (13). */
export const PAUSABLE_ESTADOS: readonly EstadoPieza[] = ESTADOS.filter(
  (estado) => estado !== 'pausada' && !TERMINAL_ESTADOS.includes(estado),
);

type Pair = readonly [EstadoPieza, EstadoPieza];

// The main chain of section 15.
const CHAIN: readonly Pair[] = [
  ['planeada', 'plan_aprobado'],
  ['plan_aprobado', 'guion_listo'],
  ['guion_listo', 'en_produccion'],
  ['en_produccion', 'en_control_calidad'],
  ['en_control_calidad', 'revision_novaciel'],
  ['revision_novaciel', 'esperando_aprobacion'],
  ['esperando_aprobacion', 'aprobada'],
  ['aprobada', 'programada'],
  ['programada', 'publicada'],
  ['publicada', 'en_medicion'],
  ['en_medicion', 'cerrada'],
];

// The side exits of section 15.
const SIDE_EXITS: readonly Pair[] = [
  ['en_control_calidad', 'en_produccion'],
  ['esperando_aprobacion', 'con_cambios'],
  ['con_cambios', 'en_produccion'],
  ['esperando_aprobacion', 'rechazada'],
  ['programada', 'fallo_publicacion'],
  ['fallo_publicacion', 'programada'],
  // Step 9 (docs/ADR-05_APROBACION_DOS_NIVELES.md): spec 11.3 says any change after approval voids it, but section 15 has no way
  // back from `aprobada` or `programada`. Only NovaCiel uses them (the database refuses a client
  // user; the service asks for manage_plans).
  ['aprobada', 'con_cambios'],
  ['programada', 'con_cambios'],
  // Step 8 (docs/ADR-05_APROBACION_DOS_NIVELES.md): with the bridge gone the internal level decides only in `revision_novaciel`,
  // and its "cambios" decision needs a way out of it. NovaCiel only, like the two above; it is not a client change round.
  ['revision_novaciel', 'con_cambios'],
];

/**
 * All allowed (desde, hacia) pairs: 11 + 9 + 13 into `pausada` + 13 out of it = 46. Leaving
 * `pausada` is further restricted to the piece's own `estado_previo` (see canTransition).
 */
export const ALLOWED_TRANSITIONS: readonly Pair[] = [
  ...CHAIN,
  ...SIDE_EXITS,
  ...PAUSABLE_ESTADOS.map((estado): Pair => [estado, 'pausada']),
  ...PAUSABLE_ESTADOS.map((estado): Pair => ['pausada', estado]),
];

const ALLOWED_KEYS = new Set(ALLOWED_TRANSITIONS.map(([desde, hacia]) => `${desde}>${hacia}`));

export function isAllowedTransition(desde: EstadoPieza, hacia: EstadoPieza): boolean {
  return ALLOWED_KEYS.has(`${desde}>${hacia}`);
}

/**
 * Whether a piece in `desde` (paused from `estadoPrevio`, if paused) may move to `hacia`: it must be
 * an allowed pair, and a paused piece may only return to where it was paused from.
 */
export function canTransition(desde: EstadoPieza, hacia: EstadoPieza, estadoPrevio: EstadoPieza | null): boolean {
  if (!isAllowedTransition(desde, hacia)) return false;
  return desde !== 'pausada' || hacia === estadoPrevio;
}
