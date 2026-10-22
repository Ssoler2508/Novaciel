import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { listarAvisosEncolados } from '../modules/aprobaciones/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { parsePieceApproveArgs } from './aprobacionesArgs.js';
import { runPieceApprove } from './aprobacionesCore.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';
import { withDevRecordatorios } from './devQueue.js';

const SCRIPT = 'piece:approve';

/**
 * `npm run piece:approve -- --cliente <id> --pieza <id> --nivel interno|cliente --como <email>`
 * Development-only. Records an approval of the CURRENT production as that user (their real roles; the
 * service and the database refuse a NovaCiel user at the client level), reading the current hash itself.
 * After the internal approval it prints the reminder jobs queued for the client.
 * Refuses production and *_test databases. Prints ids, states and hashes only.
 */
async function main(): Promise<void> {
  const args = parsePieceApproveArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);
  const result = await withDevRecordatorios((recordatorios) =>
    runPieceApprove({ db: pool, recordatorios, avisos: (id) => listarAvisosEncolados(pool, id) }, args),
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
