import { RemotionLicenciaNoConfiguradaError } from './errors.js';

// THE LICENSE GATE of Remotion (Step 7c). One file to revisit when the situation changes.
//
// The code cannot know whether a license is valid: it records the operator's DECLARATION in
// REMOTION_LICENCIA ("gratuita" or "empresa") and nothing else. With no declaration, Remotion is
// DISABLED: no template is picked, no Remotion code path runs, and reels are made with the plain text
// overlays of Step 7b. Details, terms and review triggers: docs/ADR-06_REMOTION_LICENCIA.md.

export type LicenciaRemotion = 'gratuita' | 'empresa';

/**
 * What "gratuita" rests on, written down so it is easy to find and to revisit (it matches ADR-06). It is
 * not checked by any code: when it stops being true, set REMOTION_LICENCIA to "empresa" (after buying the
 * license) or leave it unset. No licenseKey is used and nothing is sent to Remotion.
 */
export const SUPUESTO_LICENCIA = {
  supuesto: 'NovaCiel is a for-profit organization of at most 3 people and its Remotion account is on the free plan',
  planConfirmado: 'gratuita',
  /** The developer confirmed that NovaCiel's account is on the free plan. */
  planConfirmadoEl: '2026-10-22',
  /** The license terms were last read on the official pages. */
  terminosVerificadosEl: '2026-10-21',
  /**
   * OPEN, for NovaCiel to answer before production use: the developer is a freelance contractor. If a
   * contractor counts as a person, NovaCiel is 4 people and needs the company license.
   */
  preguntaAbierta: 'Does the freelance contractor count as a person of NovaCiel (3 or 4 people)?',
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
