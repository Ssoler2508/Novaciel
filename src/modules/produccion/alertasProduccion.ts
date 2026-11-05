import { VoiceProviderError } from '../../lib/ai/voice/types.js';
import { raiseAlertBestEffort, type AlertasDeps } from '../alertas/raiseAlert.js';
import type { ClienteId } from '../shared/clienteId.js';
import { CapaTextoError, RemotionNoDisponibleError } from './errors.js';

/**
 * Raises voz_fallo or capa_texto_fallo when a production fails because the voice provider or the animated-text
 * engine failed (the QC-derived alerts of the same codes cover reports that fail later). Called from the catch of
 * producirPieza, so it covers the production job, the plan job and `piece:produce`. Parameters are closed codes and
 * ids: the kind of the voice error (auth, quota, rate_limit, bad_request, server, timeout) or the reason code of
 * the text engine; never the message, the text or anything the provider replied. The attempt is identified by the
 * piece and the instant it started, so each failed attempt is one alert and one attempt never raises twice.
 * Any other error raises nothing here (a failed job is reported by withFailureAlert).
 */
export async function alertarFalloDeProduccion(
  alertas: AlertasDeps | undefined,
  clienteId: ClienteId,
  piezaId: string,
  intentoEn: Date,
  error: unknown,
): Promise<void> {
  if (error instanceof VoiceProviderError) {
    await raiseAlertBestEffort(alertas, 'voz_fallo', { clienteId, parametros: { pieza_id: piezaId, intento_en: intentoEn.toISOString(), tipo: error.kind } });
  } else if (error instanceof RemotionNoDisponibleError || error instanceof CapaTextoError) {
    await raiseAlertBestEffort(alertas, 'capa_texto_fallo', { clienteId, parametros: { pieza_id: piezaId, intento_en: intentoEn.toISOString(), razon: error.razon } });
  }
}
