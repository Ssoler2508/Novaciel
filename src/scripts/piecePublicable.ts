import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { createStorage } from '../lib/media/storage/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { parsePiecePublicableArgs } from './aprobacionesArgs.js';
import { runPiecePublicable } from './aprobacionesCore.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';

const SCRIPT = 'piece:publicable';

/**
 * `npm run piece:publicable -- --cliente <id> --pieza <id>`
 * Development-only and READ-ONLY. Calls the publish gate (assertPublicable): re-reads every stored file,
 * recomputes the hashes and checks both approvals, the facts and the media. Prints PUBLICABLE, or the
 * refusal's error name with ids. Refuses production and *_test databases.
 */
async function main(): Promise<void> {
  const args = parsePiecePublicableArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}"), storage: ${config.storage.driver}`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);
  const result = await runPiecePublicable({ db: pool, storage: createStorage(config.storage) }, args);
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : `${SCRIPT} failed`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
