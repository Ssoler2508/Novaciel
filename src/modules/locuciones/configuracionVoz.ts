import { z } from 'zod';
import { VELOCIDAD_MAX, VELOCIDAD_MIN, type AjustesVoz } from './claveCache.js';

// The voice of a client, inside the `voz` block of the brand profile under `locucion` (Step 7d, ADR-08).
// Stock voices only: the voice id is a provider id chosen per client, never code, and there is no field for
// a cloned voice. It is not checked against the provider's library (a wrong id fails the first call with a
// typed error); `voice:smoke --voz <id>` checks one by hand.

const unidad = z.number().min(0).max(1);

export const esquemaLocucionCliente = z
  .object({
    habilitada: z.boolean(),
    voice_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    idioma: z.string().regex(/^[a-z]{2}$/),
    estabilidad: unidad.default(0.5),
    similitud: unidad.default(0.75),
    estilo: unidad.default(0),
    velocidad: z.number().min(VELOCIDAD_MIN).max(VELOCIDAD_MAX).default(1),
    refuerzo_voz: z.boolean().default(true),
  })
  .strict();

export interface VozDelCliente {
  vozId: string;
  ajustes: AjustesVoz;
}

/** The profile has a `locucion` block that is not valid. Carries the NAMES of the fields only, never their values. */
export class ConfiguracionVozInvalidaError extends Error {
  constructor(readonly campos: readonly string[]) {
    super(`The voice configuration of the profile is invalid: ${campos.join(', ')}`);
    this.name = 'ConfiguracionVozInvalidaError';
  }
}

/**
 * The client's voice from `perfil.voz`, or null when there is none (no `locucion` block, or it is not enabled).
 * Throws ConfiguracionVozInvalidaError for a block that is present but invalid.
 */
export function vozDelCliente(voz: unknown): VozDelCliente | null {
  const bloque = voz !== null && typeof voz === 'object' ? (voz as Record<string, unknown>)['locucion'] : undefined;
  if (bloque === undefined || bloque === null) return null;
  const resultado = esquemaLocucionCliente.safeParse(bloque);
  if (!resultado.success) {
    throw new ConfiguracionVozInvalidaError([...new Set(resultado.error.issues.map((i) => i.path.filter((p) => typeof p === 'string').join('.') || 'locucion'))]);
  }
  const c = resultado.data;
  if (!c.habilitada) return null;
  return {
    vozId: c.voice_id,
    ajustes: { estabilidad: c.estabilidad, similitud: c.similitud, estilo: c.estilo, velocidad: c.velocidad, refuerzoVoz: c.refuerzo_voz, idioma: c.idioma },
  };
}
