import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { createStorage } from '../lib/media/storage/index.js';
import { createPublishProvider } from '../lib/publish/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { runPieceSchedule } from './publicacionesCore.js';
import { parsePieceScheduleArgs } from './publicacionesArgs.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';
import { withDevProgramacion } from './devQueue.js';

const SCRIPT = 'piece:schedule';

/**
 * `npm run piece:schedule -- --cliente <id> --pieza <id> --at <ISO 8601>`
 * Development-only. Schedules an approved piece (or reschedules a programada one, or retries one in
 * fallo_publicacion) for that time, through the same rules and the same gate as the route: the time must be in the
 * future and outside the vetoed hours, and the piece must be publishable now. Queues the reminders and the
 * scheduled send inside the transaction; no worker runs here, the server delivers them.
 * Refuses production and *_test databases. Prints ids, states and times only.
 */
async function main(): Promise<void> {
  const args = parsePieceScheduleArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}"), storage: ${config.storage.driver}`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);
  const storage = createStorage(config.storage);
  const provider = createPublishProvider(config.publish);
  const result = await withDevProgramacion((puertos) => runPieceSchedule({ db: pool, storage, provider, ...puertos }, args));
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
