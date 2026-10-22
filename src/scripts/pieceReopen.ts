import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { parsePieceReopenArgs } from './aprobacionesArgs.js';
import { runPieceReopen } from './aprobacionesCore.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';

const SCRIPT = 'piece:reopen';

/**
 * `npm run piece:reopen -- --cliente <id> --pieza <id> --motivo <text>`
 * Development-only. NovaCiel (the seeded administrator) pulls an approved or scheduled piece back to
 * con_cambios (spec 11.3: any change after the approval voids it). Then produce the next version with
 * `piece:produce --reproducir`: the new hash voids every earlier approval.
 * Refuses production and *_test databases. Prints ids and states only.
 */
async function main(): Promise<void> {
  const args = parsePieceReopenArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);
  const result = await runPieceReopen({ db: pool }, args);
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
