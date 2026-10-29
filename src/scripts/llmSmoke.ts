import { config } from '../config/index.js';
import { closePool, pool } from '../db/pool.js';
import { LogAlertSink } from '../lib/ai/alerts.js';
import { createLLMProvider } from '../lib/ai/index.js';
import { getClienteById } from '../modules/clientes/clientesRepository.js';
import { parseLlmSmokeArgs } from './llmSmokeArgs.js';
import { formatSmokeReport, runLlmSmoke } from './llmSmokeCore.js';
import { assertLlmSmokeAllowed, confirmLlmSmokeDatabase } from './llmSmokeGuard.js';

/**
 * `npm run llm:smoke -- --cliente <id>`: development-only manual check of the real provider. Makes
 * one tiny paid call per model tier through the full path and prints only, per tier, model, tokens,
 * cost and outcome, plus the remaining budget. Never prints the key, the prompt or the output.
 */
async function main(): Promise<void> {
  const { clienteId } = parseLlmSmokeArgs(process.argv.slice(2));
  const urlName = assertLlmSmokeAllowed({
    nodeEnv: config.NODE_ENV,
    databaseUrl: config.DATABASE_URL,
    llmProvider: config.llm.provider,
    hasApiKey: config.llm.apiKey !== undefined,
  });
  const database = await confirmLlmSmokeDatabase(pool);
  console.log(`Database "${database}" (url name "${urlName}")`);
  if (!(await getClienteById(pool, clienteId))) throw new Error('llm:smoke refused: that client does not exist');

  const report = await runLlmSmoke({
    db: pool,
    provider: createLLMProvider(config.llm),
    alerts: new LogAlertSink(),
    clienteId,
  });
  for (const line of formatSmokeReport(report)) console.log(line);
  if (report.tiers.some((t) => t.outcome !== 'ok')) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    // Message only: never print the error object, which could carry connection details.
    console.error(err instanceof Error ? err.message : 'llm:smoke failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
