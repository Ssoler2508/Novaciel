import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';
import { parseVoiceConfigureArgs } from './voiceConfigureArgs.js';
import { configureVoice } from './voiceConfigureCore.js';

const SCRIPT = 'voice:configure';

/**
 * `npm run voice:configure -- --cliente <id> --admin-email <email> --voz <voice id> --idioma es [--velocidad 1]
 * [--estabilidad 0.5] [--similitud 0.75] [--estilo 0]`, or `... --desactivar`.
 * Development-only. Sets the client's voice-over in the profile (`voz.locucion`) as a new profile version made by a
 * NovaCiel administrator. Stock voice ids only (no cloning). The voice id is not checked against the provider's
 * library; use `voice:smoke --voz <id>` to try one. Refuses production and *_test databases. Prints ids only.
 */
async function main(): Promise<void> {
  const args = parseVoiceConfigureArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);
  const result = await configureVoice(pool, args);
  console.log(
    result.changed
      ? `Profile ${result.perfilId} (version ${result.version}): voice ${args.desactivar ? 'turned off' : 'configured'}`
      : `Profile ${result.perfilId} (version ${result.version}) already has this voice setting: nothing changed`,
  );
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : `${SCRIPT} failed`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
