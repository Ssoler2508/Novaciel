import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';

export interface PlanApproveInternalArgs {
  clienteId: ClienteId;
  planId: string;
}

const USAGE = 'options are --cliente <id> --plan <id>';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts `--cliente <uuid>` and `--plan <uuid>` (also `--flag=value`). Messages never echo values. */
export function parsePlanApproveInternalArgs(argv: readonly string[]): PlanApproveInternalArgs {
  const values = new Map<'cliente' | 'plan', string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${USAGE}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (name !== 'cliente' && name !== 'plan') throw new Error(`Unknown option --${name.slice(0, 40)}: ${USAGE}`);
    if (values.has(name)) throw new Error(`Option --${name} was given more than once`);
    let value: string | undefined;
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(`Option --${name} needs a value`);
    values.set(name, value.trim());
  }
  const cliente = values.get('cliente');
  const plan = values.get('plan');
  if (cliente === undefined) throw new Error('Option --cliente <id> is required');
  if (plan === undefined) throw new Error('Option --plan <id> is required');
  let clienteId: ClienteId;
  try {
    clienteId = asClienteId(cliente);
  } catch {
    throw new Error('Option --cliente must be a client id (UUID)');
  }
  if (!UUID_RE.test(plan)) throw new Error('Option --plan must be a plan id (UUID)');
  return { clienteId, planId: plan };
}
