import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { createMediaProbe } from '../lib/media/probe/index.js';
import { createStorage } from '../lib/media/storage/index.js';
import { parseMediaUploadArgs } from './mediaUploadArgs.js';
import { runMediaUpload } from './mediaUploadCore.js';
import { assertMediaUploadAllowed, confirmMediaUploadDatabase } from './mediaUploadGuard.js';

/**
 * `npm run media:upload -- --cliente <id> --file <path> --tags a,b --aparece-gente <true|false> [--autorizacion <id>]`
 * Development-only: uploads one real photo or video for a client through uploadMedia (actor
 * sistema). Refuses production and *_test databases. Prints the media id and its technical data;
 * never the file content.
 */
async function main(): Promise<void> {
  const args = parseMediaUploadArgs(process.argv.slice(2));
  const urlName = assertMediaUploadAllowed({ nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmMediaUploadDatabase(pool);
  console.log(`Database "${database}" (url name "${urlName}")`);

  const result = await runMediaUpload(
    { db: pool, storage: createStorage(config.storage), probe: createMediaProbe(config.media), maxBytes: config.media.maxBytes },
    args,
  );
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : 'media:upload failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
