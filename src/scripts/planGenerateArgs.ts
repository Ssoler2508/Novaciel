import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';
import { isValidLocalDate } from '../modules/planificador/fechas.js';

export interface PlanGenerateArgs {
  clienteId: ClienteId;
  /** Any date of the wanted week (YYYY-MM-DD); undefined = next week. */
  semana?: string;
  reemplazar: boolean;
}

const USAGE = 'options are --cliente <id> [--semana YYYY-MM-DD] [--reemplazar]';

/**
 * Accepts `--cliente <uuid>`, `--semana <date>` (also `--flag=value`) and the bare flag
 * `--reemplazar`. Error messages name the option and never repeat its value.
 */
export function parsePlanGenerateArgs(argv: readonly string[]): PlanGenerateArgs {
  const values = new Map<'cliente' | 'semana', string>();
  let reemplazar = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${USAGE}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (name === 'reemplazar') {
      if (eq !== -1) throw new Error('Option --reemplazar takes no value');
      if (reemplazar) throw new Error('Option --reemplazar was given more than once');
      reemplazar = true;
      continue;
    }
    if (name !== 'cliente' && name !== 'semana') throw new Error(`Unknown option --${name.slice(0, 40)}: ${USAGE}`);
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
  const semana = values.get('semana');
  if (semana !== undefined && !isValidLocalDate(semana)) throw new Error('Option --semana must be a real date, YYYY-MM-DD');
  return { clienteId, ...(semana !== undefined ? { semana } : {}), reemplazar };
}
