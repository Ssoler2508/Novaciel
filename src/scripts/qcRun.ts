import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { createStorage } from '../lib/media/storage/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';
import { parseQcRunArgs } from './qcRunArgs.js';
import { runQcRun } from './qcRunCore.js';

const SCRIPT = 'qc:run';

/**
 * `npm run qc:run -- --cliente <id> (--pieza <id> | --plan <id>)`
 * Development-only. Runs quality control (as the system) on a piece waiting in en_control_calidad, or on
 * every such piece of a plan: the way to control pieces left there in development data, or when the
 * server's worker is not running. Re-reads the stored files and moves the piece (revision_novaciel on a
 * pass, en_produccion on a fail). Refuses production and *_test databases. Prints ids, the result and
 * the failed codes: NEVER the copy of a piece.
 */
async function main(): Promise<void> {
  const args = parseQcRunArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}"), storage: ${config.storage.driver}`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);

  const result = await runQcRun(
    { db: pool, storage: createStorage(config.storage), reel: { ffprobePath: config.media.ffprobePath, ffprobeTimeoutMs: config.media.ffprobeTimeoutMs } },
    args,
  );
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
