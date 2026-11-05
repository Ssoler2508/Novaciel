import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { createStorage } from '../lib/media/storage/index.js';
import { createPublishProvider } from '../lib/publish/index.js';
import { LogNotifier } from '../lib/notificaciones/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { runPublishMetrics } from './publicacionesCore.js';
import { parsePublishMetricsArgs } from './publicacionesArgs.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';

const SCRIPT = 'publish:metrics';

/**
 * `npm run publish:metrics -- --cliente <id> --pieza <id>`
 * Development-only. Collects the NEXT metrics window (24h, 72h, 7d, 28d) of a published piece now, as if its time had
 * come, with the same code as the scheduled job. Run it again for the following window. The provider is the one
 * PUBLISH_PROVIDER chose (the fake: deterministic numbers). Refuses production and *_test databases.
 */
async function main(): Promise<void> {
  const args = parsePublishMetricsArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}"), provider: ${config.publish.provider}`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);
  const alertas = { db: pool, notifier: new LogNotifier(), umbrales: config.alertas.umbralesPresupuesto };
  const result = await runPublishMetrics(
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
