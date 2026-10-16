import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';

export type BriefGenerateArgs =
  | { modo: 'plan'; clienteId: ClienteId; planId: string }
  | { modo: 'pieza'; clienteId: ClienteId; piezaId: string; regenerar: boolean };

const USAGE = 'options are --cliente <id> (--plan <id> | --pieza <id>) [--regenerar]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts `--cliente`, exactly one of `--plan` / `--pieza` (also `--flag=value`) and the bare flag
 * `--regenerar` (only with `--pieza`). Error messages name the option and never repeat its value.
 */
export function parseBriefGenerateArgs(argv: readonly string[]): BriefGenerateArgs {
  const values = new Map<'cliente' | 'plan' | 'pieza', string>();
  let regenerar = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${USAGE}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (name === 'regenerar') {
      if (eq !== -1) throw new Error('Option --regenerar takes no value');
      if (regenerar) throw new Error('Option --regenerar was given more than once');
      regenerar = true;
      continue;
    }
    if (name !== 'cliente' && name !== 'plan' && name !== 'pieza') throw new Error(`Unknown option --${name.slice(0, 40)}: ${USAGE}`);
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
  if (cliente === undefined) throw new Error('Option --cliente <id> is required');
  let clienteId: ClienteId;
  try {
    clienteId = asClienteId(cliente);
  } catch {
    throw new Error('Option --cliente must be a client id (UUID)');
  }
  const plan = values.get('plan');
  const pieza = values.get('pieza');
  if ((plan === undefined) === (pieza === undefined)) throw new Error('Give exactly one of --plan <id> or --pieza <id>');
  if (plan !== undefined) {
    if (regenerar) throw new Error('Option --regenerar only works with --pieza');
    if (!UUID_RE.test(plan)) throw new Error('Option --plan must be a plan id (UUID)');
    return { modo: 'plan', clienteId, planId: plan };
  }
  if (!UUID_RE.test(pieza!)) throw new Error('Option --pieza must be a piece id (UUID)');
  return { modo: 'pieza', clienteId, piezaId: pieza!, regenerar };
}
