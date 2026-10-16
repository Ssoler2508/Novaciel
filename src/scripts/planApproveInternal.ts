import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';
import { parsePlanApproveInternalArgs } from './planApproveInternalArgs.js';
import { runPlanApproveInternal } from './planApproveInternalCore.js';

const SCRIPT = 'plan:approve-internal';

/**
 * `npm run plan:approve-internal -- --cliente <id> --plan <id>`
 *
 * TEMPORARY until Step 9 (the client's approval of the plan replaces it). Development-only: approves
 * a draft plan and moves its pieces from planeada to plan_aprobado, as the system, so the creative
 * director can work. There is deliberately NO HTTP route for this: the permission matrix forbids
 * NovaCiel staff approving in the client's name. Refuses production and *_test databases. Prints
 * only ids, states and counts.
 */
async function main(): Promise<void> {
  const args = parsePlanApproveInternalArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);

  const result = await runPlanApproveInternal(pool, args);
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
