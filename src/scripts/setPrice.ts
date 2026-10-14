import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { microToUsd } from '../modules/presupuesto/money.js';
import { assertAdminDatabaseAllowed, confirmAdminDatabase } from './adminGuard.js';
import { parseSetPriceArgs } from './setPriceArgs.js';
import { setPriceAsAdmin } from './setPriceCore.js';

/**
 * `npm run set-price -- --provider <p> --model <m> --input <usd-per-million> --output <usd-per-million>
 * --admin-email <email> [--nota <text>]`: writes a new model price as that administrator, through
 * setModelPrice (real permission check and audit row). Prices are not secret, so flags are fine.
 * Take the numbers from the provider's official pricing page. Refuses *_test databases (same
 * guard as create-admin).
 */
async function main(): Promise<void> {
  const args = parseSetPriceArgs(process.argv.slice(2));
  const urlName = assertAdminDatabaseAllowed(config.DATABASE_URL);
  const database = await confirmAdminDatabase(pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  const price = await setPriceAsAdmin(pool, args);
  console.log(`Price written for ${price.provider}/${price.model}`);
  console.log(`  input  USD ${microToUsd(price.inputPerMillion)} per million tokens`);
  console.log(`  output USD ${microToUsd(price.outputPerMillion)} per million tokens`);
  console.log(`  valid from ${price.vigenteDesde.toISOString()}`);
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : 'set-price failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
