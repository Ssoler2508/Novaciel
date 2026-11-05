import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { createStorage } from '../lib/media/storage/index.js';
import { createPublishProvider } from '../lib/publish/index.js';
import { LogNotifier } from '../lib/notificaciones/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { runPiecePublish } from './publicacionesCore.js';
import { parsePiecePublishArgs } from './publicacionesArgs.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';

const SCRIPT = 'piece:publish';

/**
 * `npm run piece:publish -- --cliente <id> --pieza <id>`
 * Development-only. Publishes a programada piece NOW through the same gate as the scheduled job: the central
 * rule is checked with the piece locked (both approvals of the exact files, QC, valid facts, files re-hashed), the
 * attempt is recorded before the call, and a second run never sends again (it looks the post up by its key). The
 * provider is the one PUBLISH_PROVIDER chose (the fake: nothing leaves this machine).
 * Refuses production and *_test databases. Prints ids, states and the external id only.
 */
async function main(): Promise<void> {
  const args = parsePiecePublishArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}"), storage: ${config.storage.driver}, provider: ${config.publish.provider}`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);
  const alertas = { db: pool, notifier: new LogNotifier(), umbrales: config.alertas.umbralesPresupuesto };
  const result = await runPiecePublish(
    { db: pool, storage: createStorage(config.storage), provider: createPublishProvider(config.publish), alertas },
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
