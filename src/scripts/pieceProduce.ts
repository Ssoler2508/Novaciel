import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { createStorage, LocalFileStorage } from '../lib/media/storage/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';
import { parsePieceProduceArgs } from './pieceProduceArgs.js';
import { runPieceProduce } from './pieceProduceCore.js';

const SCRIPT = 'piece:produce';

/**
 * `npm run piece:produce -- --cliente <id> (--plan <id> | --pieza <id>) [--reproducir]`
 * Development-only: produces the final image files of a plan's pieces, or of one piece, through the
 * production service (actor sistema). No model call and no cost: it only crops, resizes and draws the
 * text of the brief on the client's real media. Refuses production and *_test databases. Prints ids,
 * sizes, hashes and (local storage) the path of each file: NEVER the copy of a piece.
 */
async function main(): Promise<void> {
  const args = parsePieceProduceArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  const storage = createStorage(config.storage);
  console.log(`Database "${database}" (url name "${urlName}"), storage: ${config.storage.driver}`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);

  const result = await runPieceProduce(
    { db: pool, storage, ...(storage instanceof LocalFileStorage ? { localPath: (key: string) => storage.localPath(key) } : {}) },
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
