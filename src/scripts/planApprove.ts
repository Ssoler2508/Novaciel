import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { listarAvisosEncolados } from '../modules/aprobaciones/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { parsePlanApproveArgs } from './aprobacionesArgs.js';
import { runPlanApprove } from './aprobacionesCore.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';
import { withDevRecordatorios } from './devQueue.js';

const SCRIPT = 'plan:approve';

/**
 * `npm run plan:approve -- --cliente <id> --plan <id>`
 * Development-only. Proposes the plan as the seeded NovaCiel administrator (if it is a draft) and approves
 * it AS THE SEEDED FICTIONAL CLIENT APPROVER (never a NovaCiel user), reading the plan fingerprint itself.
 * The reminders of the plan are queued in pg-boss. Replaces the old internal approval.
 * Refuses production and *_test databases. Prints ids and states only.
 */
async function main(): Promise<void> {
  const args = parsePlanApproveArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);
  const result = await withDevRecordatorios((recordatorios) =>
    runPlanApprove({ db: pool, recordatorios, avisos: (id) => listarAvisosEncolados(pool, id) }, args),
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
