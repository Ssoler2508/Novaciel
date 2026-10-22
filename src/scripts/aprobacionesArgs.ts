import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';

// Arguments of the Step 9 development scripts. Error messages name the option and never repeat its value.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** `--name value` or `--name=value`, each option at most once, only the names in `allowed`. */
function parseFlags(argv: readonly string[], allowed: readonly string[], usage: string): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${usage}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (!allowed.includes(name)) throw new Error(`Unknown option --${name.slice(0, 40)}: ${usage}`);
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
  return values;
}

function uuid(values: Map<string, string>, name: string, label: string): string {
  const value = values.get(name);
  if (value === undefined) throw new Error(`Option --${name} <id> is required`);
  if (!UUID_RE.test(value)) throw new Error(`Option --${name} must be a ${label} id (UUID)`);
  return value;
}

function cliente(values: Map<string, string>): ClienteId {
  uuid(values, 'cliente', 'client');
  return asClienteId(values.get('cliente')!);
}

export interface PlanApproveArgs {
  clienteId: ClienteId;
  planId: string;
}
export function parsePlanApproveArgs(argv: readonly string[]): PlanApproveArgs {
  const v = parseFlags(argv, ['cliente', 'plan'], 'options are --cliente <id> --plan <id>');
  return { clienteId: cliente(v), planId: uuid(v, 'plan', 'plan') };
}

export interface PieceApproveArgs {
  clienteId: ClienteId;
  piezaId: string;
  nivel: 'interno' | 'cliente';
  como: string;
}
export function parsePieceApproveArgs(argv: readonly string[]): PieceApproveArgs {
  const v = parseFlags(argv, ['cliente', 'pieza', 'nivel', 'como'], 'options are --cliente <id> --pieza <id> --nivel interno|cliente --como <email>');
  const nivel = v.get('nivel');
  if (nivel !== 'interno' && nivel !== 'cliente') throw new Error('Option --nivel must be interno or cliente');
  const como = v.get('como');
  if (como === undefined || !EMAIL_RE.test(como)) throw new Error('Option --como <email> is required and must be an email');
  return { clienteId: cliente(v), piezaId: uuid(v, 'pieza', 'piece'), nivel, como: como.toLowerCase() };
}

export interface PieceReopenArgs {
  clienteId: ClienteId;
  piezaId: string;
  motivo: string;
}
export function parsePieceReopenArgs(argv: readonly string[]): PieceReopenArgs {
  const v = parseFlags(argv, ['cliente', 'pieza', 'motivo'], 'options are --cliente <id> --pieza <id> --motivo <text>');
  const motivo = v.get('motivo');
  if (motivo === undefined) throw new Error('Option --motivo <text> is required');
  if (motivo.length > 500) throw new Error('Option --motivo must have at most 500 characters');
  return { clienteId: cliente(v), piezaId: uuid(v, 'pieza', 'piece'), motivo };
}

export interface PiecePublicableArgs {
  clienteId: ClienteId;
  piezaId: string;
}
export function parsePiecePublicableArgs(argv: readonly string[]): PiecePublicableArgs {
  const v = parseFlags(argv, ['cliente', 'pieza'], 'options are --cliente <id> --pieza <id>');
  return { clienteId: cliente(v), piezaId: uuid(v, 'pieza', 'piece') };
}

export interface PasswordSetDevArgs {
  email: string;
}
export function parsePasswordSetDevArgs(argv: readonly string[]): PasswordSetDevArgs {
  const v = parseFlags(argv, ['email'], 'options are --email <email>');
  const email = v.get('email');
  if (email === undefined || !EMAIL_RE.test(email)) throw new Error('Option --email <email> is required and must be an email');
  if (!email.toLowerCase().endsWith('@example.test')) throw new Error('password:set-dev only works for fictional users (@example.test)');
  return { email: email.toLowerCase() };
}
