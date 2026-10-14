import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { runInTransaction } from '../db/transaction.js';
import { createMediaProbe } from '../lib/media/probe/index.js';
import { isFfprobeAvailable } from '../lib/media/probe/ffprobeAvailable.js';
import { createStorage } from '../lib/media/storage/index.js';
import { assertSeedAllowed, confirmSeedDatabase } from './seedGuard.js';
import { seedDevelopment, type SeedOptions } from './seedDevelopment.js';

/**
 * `npm run seed`: fictional data for local development only. Never prints DATABASE_URL or any part
 * of it other than the database name.
 */
async function main(): Promise<void> {
  // Guard 1, before connecting: environment and the name in the URL.
  const urlName = assertSeedAllowed({ nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  // Guard 2, once connected: the server's own current_database().
  const database = await confirmSeedDatabase(pool);
  console.log(`Seeding database "${database}" (url name "${urlName}")`);

  // Media need a working ffprobe (the seed goes through uploadMedia, which probes every file).
  const ffprobeOk = isFfprobeAvailable(config.media.ffprobePath);
  const options: SeedOptions = ffprobeOk
    ? { media: { storage: createStorage(config.storage), probe: createMediaProbe(config.media), maxBytes: config.media.maxBytes } }
    : { mediaSkippedReason: `media (ffprobe not found at "${config.media.ffprobePath}"; install it or set FFPROBE_PATH)` };

  const result = await runInTransaction(pool, (tx) => seedDevelopment(tx, new Date(), options));

  console.log(`Created: ${result.created.length}`);
  for (const item of result.created) console.log(`  + ${item}`);
  console.log(`Already present: ${result.existing.length}`);
  for (const item of result.existing) console.log(`  = ${item}`);

  for (const item of result.skipped) console.log(`Skipped: ${item}`);

  console.log('Completeness per block:');
  if (result.completeness) {
    for (const [block, info] of Object.entries(result.completeness.blocks)) {
      const flag = info.mandatory ? '' : ' (not mandatory)';
      const missing = info.missing.length > 0 ? ` missing: ${info.missing.join(', ')}` : '';
      console.log(`  ${block.padEnd(22)} ${String(info.percent).padStart(3)}%${flag}${missing}`);
    }
  } else {
    console.log('  (no current profile)');
  }
  console.log(`puedePlanificar: ${result.puedePlanificar}`);
  // The fictional client must be complete after seeding.
  if (!result.puedePlanificar) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : 'Seed failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
