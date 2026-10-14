import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';

/**
 * Accepts only --cliente <uuid> (or --cliente=<uuid>). Error messages never include the argument
 * values.
 */
export function parseLlmSmokeArgs(argv: readonly string[]): { clienteId: ClienteId } {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error('Unexpected argument: only --cliente <id> is accepted');
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (name !== 'cliente') throw new Error(`Unknown option --${name.slice(0, 40)}: only --cliente is accepted`);
    if (value !== undefined) throw new Error('Option --cliente was given more than once');
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error('Option --cliente needs a value');
    value = value.trim();
  }
  if (value === undefined) throw new Error('Option --cliente <id> is required');
  try {
    return { clienteId: asClienteId(value) };
  } catch {
    // Do not echo the value.
    throw new Error('Option --cliente must be a client id (UUID)');
  }
}
