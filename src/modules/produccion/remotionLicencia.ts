import { RemotionLicenciaNoConfiguradaError } from './errors.js';

// THE LICENSE GATE of Remotion (Step 7c). One file to revisit when the situation changes.
//
// The code cannot know whether a license is valid: it records the operator's DECLARATION in
// REMOTION_LICENCIA ("gratuita" or "empresa") and nothing else. With no declaration, Remotion is
// DISABLED: no template is picked, no Remotion code path runs, and reels are made with the plain text
// overlays of Step 7b. Details, terms and review triggers: docs/ADR-06_REMOTION_LICENCIA.md.

export type LicenciaRemotion = 'gratuita' | 'empresa';

/**
 * The assumption behind "gratuita", written down so it is easy to find and to revisit. It is not checked
 * by any code: when it stops being true, set REMOTION_LICENCIA to "empresa" (after buying the license) or
 * leave it unset.
 */
export const SUPUESTO_LICENCIA = {
  supuesto: 'NovaCiel is a for-profit organization of at most 3 people, so the Remotion free license applies',
  verificadoEl: '2026-10-21',
  adr: 'docs/ADR-06_REMOTION_LICENCIA.md',
} as const;

/** The declared license, or undefined when Remotion is disabled. */
export function licenciaRemotion(config: { remotion: { licencia: LicenciaRemotion | undefined } }): LicenciaRemotion | undefined {
  return config.remotion.licencia;
}

/** True when Remotion may be used at all (a license was declared). */
export function remotionHabilitado(config: { remotion: { licencia: LicenciaRemotion | undefined } }): boolean {
  return licenciaRemotion(config) !== undefined;
}

/** The declared license, or throws RemotionLicenciaNoConfiguradaError. Every Remotion code path calls this first. */
export function exigirLicenciaRemotion(config: { remotion: { licencia: LicenciaRemotion | undefined } }): LicenciaRemotion {
  const licencia = licenciaRemotion(config);
  if (licencia === undefined) throw new RemotionLicenciaNoConfiguradaError();
  return licencia;
}
