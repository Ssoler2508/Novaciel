import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { createVoiceProvider } from '../lib/ai/voice/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { createVozRuntime } from '../modules/produccion/vozRuntime.js';
import { parseVoiceSmokeArgs } from './voiceSmokeArgs.js';
import { formatVoiceSmokeReport, runVoiceSmoke } from './voiceSmokeCore.js';
import { assertVoiceSmokeAllowed, confirmVoiceSmokeDatabase } from './voiceSmokeGuard.js';

/**
 * `npm run voice:smoke -- --cliente <id> [--voz <voice id>]`: development-only manual check of the real voice
 * provider. Makes ONE short paid call through the whole budget path and prints only the model, the voice, the
 * characters, the duration and the cost. Never prints the key, the text or the provider's reply. Needs
 * VOICE_PROVIDER=elevenlabs, TTS_MODEL, ELEVENLABS_API_KEY, a price in characters (npm run set-price) and budget.
 * Writes one ledger row (unit "caracteres", purpose smoke_test_voz).
 */
async function main(): Promise<void> {
  const { clienteId, vozId } = parseVoiceSmokeArgs(process.argv.slice(2));
  const urlName = assertVoiceSmokeAllowed({
    nodeEnv: config.NODE_ENV,
    databaseUrl: config.DATABASE_URL,
    voiceProvider: config.voice.provider,
    hasApiKey: config.voice.apiKey !== undefined,
  });
  const database = await confirmVoiceSmokeDatabase(pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  if (!(await getClienteById(pool, clienteId))) throw new Error('voice:smoke refused: that client does not exist');

  const provider = createVoiceProvider(config.voice);
  const runtime = createVozRuntime(config.voice, config.media);
  if (!provider || !runtime) throw new Error('voice:smoke refused: no voice provider is configured');
  const report = await runVoiceSmoke({ db: pool, provider, measureAudio: runtime.measureAudio, clienteId, ...(vozId !== undefined ? { vozId } : {}) });
  for (const line of formatVoiceSmokeReport(report)) console.log(line);
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : 'voice:smoke failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
