import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { LogAlertSink } from '../lib/ai/alerts.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { createLlmRuntime } from '../modules/desarrollo/developmentProvider.js';
import { parseBriefGenerateArgs } from './briefGenerateArgs.js';
import { runBriefGenerate } from './briefGenerateCore.js';
import { assertDevScriptAllowed, confirmDevScriptDatabase } from './devScriptGuard.js';

const SCRIPT = 'brief:generate';

/**
 * `npm run brief:generate -- --cliente <id> (--plan <id> | --pieza <id>) [--regenerar]`
 * Development-only: generates the creative brief of a plan's pieces, or of one piece, through the
 * director service (actor sistema). With LLM_PROVIDER=fake it uses the deterministic development
 * provider (no key needed); with claude it is the real, paid call. Refuses production and *_test
 * databases. Prints only ids, counts, error names and costs: NEVER the copy of a brief.
 */
async function main(): Promise<void> {
  const args = parseBriefGenerateArgs(process.argv.slice(2));
  const urlName = assertDevScriptAllowed(SCRIPT, { nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL });
  const database = await confirmDevScriptDatabase(SCRIPT, pool);
  console.log(`Database "${database}" (url name "${urlName}"), provider: ${config.llm.provider}`);
  if (!(await getClienteById(pool, args.clienteId))) throw new Error(`${SCRIPT} refused: that client does not exist`);

  const runtime = createLlmRuntime(config.llm, config.NODE_ENV);
  const result = await runBriefGenerate(
    { db: pool, provider: runtime.provider, alerts: new LogAlertSink(), ...(runtime.withBriefContext ? { withContext: runtime.withBriefContext } : {}) },
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
