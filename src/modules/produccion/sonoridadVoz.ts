// Loudness policy of a reel with a voice-over (Step 7d, ADR-08). PURE. All values are HOUSE VALUES, VERIFY:
//   - the target is -16 LUFS integrated, the usual level for short vertical video with speech;
//   - the reel is accepted within +-2 LU of it, and with a true peak not above -0.5 dBTP;
//   - a mix below -50 LUFS is treated as silence.
// The track is not normalized with `loudnorm` (dynamic, not repeatable): the mix is measured and ONE static
// gain brings it to the target; a limiter at -1 dBFS keeps the peaks under the ceiling.

export const OBJETIVO_LUFS = -16;
export const TOLERANCIA_LU = 2;
export const PICO_MAXIMO_DBTP = -0.5;
/** Integrated loudness at or below this is silence: no voice is audible. */
export const SILENCIO_LUFS = -50;
/** Largest gain applied, dB (the same bound the FFmpeg arguments accept). */
export const GANANCIA_MAXIMA_DB = 30;

/** The static gain, dB, that brings a measured mix to the target, rounded to 0.01 and bounded. Null for silence. */
export function calcularGanancia(medidaLufs: number): number | null {
  if (typeof medidaLufs !== 'number' || !Number.isFinite(medidaLufs) || medidaLufs <= SILENCIO_LUFS) return null;
  const bruta = OBJETIVO_LUFS - medidaLufs;
  const acotada = Math.max(-GANANCIA_MAXIMA_DB, Math.min(GANANCIA_MAXIMA_DB, bruta));
  return Math.round(acotada * 100) / 100;
}

export type ResultadoSonoridad = 'en_rango' | 'silencio' | 'volumen_fuera_de_rango';

/** Judges a measured reel: audible, and inside the loudness and true-peak limits. */
export function juzgarSonoridad(medida: { integradaLufs: number; picoVerdaderoDbtp: number | null }): ResultadoSonoridad {
  if (!Number.isFinite(medida.integradaLufs) || medida.integradaLufs <= SILENCIO_LUFS) return 'silencio';
  if (Math.abs(medida.integradaLufs - OBJETIVO_LUFS) > TOLERANCIA_LU) return 'volumen_fuera_de_rango';
  if (medida.picoVerdaderoDbtp !== null && medida.picoVerdaderoDbtp > PICO_MAXIMO_DBTP) return 'volumen_fuera_de_rango';
  return 'en_rango';
}
