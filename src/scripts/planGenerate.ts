import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { LogAlertSink } from '../lib/ai/alerts.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { createPlannerProvider } from '../modules/planificador/plannerProvider.js';
import { parsePlanGenerateArgs } from './planGenerateArgs.js';
import { runPlanGenerate } from './planGenerateCore.js';
import { assertPlanGenerateAllowed, confirmPlanGenerateDatabase } from './planGenerateGuard.js';

/**
 * `npm run plan:generate -- --cliente <id> [--semana YYYY-MM-DD] [--reemplazar]`
 * Development-only: generates a client's weekly plan through generarPlanSemanal (actor sistema).
 * With LLM_PROVIDER=fake it uses the deterministic planner fake (no key needed); with claude it is
 * the real, paid call. Refuses production and *_test databases. Prints only ids, counts, local
 * times and the cost: never the prompt or the ideas.
 */
async function main(): Promise<void> {
  const args = parsePlanGenerateArgs(process.argv.slice(2));
  const urlName = assertPlanGenerateAllowed({ nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmPlanGenerateDatabase(pool);
  console.log(`Database "${database}" (url name "${urlName}"), provider: ${config.llm.provider}`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error('plan:generate refused: that client does not exist');

  const planner = createPlannerProvider(config.llm, config.NODE_ENV);
  const result = await runPlanGenerate(
    { db: pool, provider: planner.provider, alerts: new LogAlertSink(), ...(planner.withContext ? { withContext: planner.withContext } : {}) },
    args,
  );
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : 'plan:generate failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
