import { statSync } from 'node:fs';
import path from 'node:path';
import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';

export interface MediaUploadArgs {
  clienteId: ClienteId;
  /** Absolute path of an existing regular file. */
  filePath: string;
  tags: string[];
  aparecenPersonas: boolean;
  autorizacionId?: string;
}

const FLAGS = ['cliente', 'file', 'tags', 'aparece-gente', 'autorizacion'] as const;
type Flag = (typeof FLAGS)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'options are --cliente --file --tags --aparece-gente [--autorizacion]';

/**
 * Accepts `--flag value` or `--flag=value` for cliente, file, tags, aparece-gente and (optional)
 * autorizacion. Error messages name the option and never repeat its value.
 */
export function parseMediaUploadArgs(argv: readonly string[]): MediaUploadArgs {
  const raw = new Map<Flag, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${USAGE}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (!(FLAGS as readonly string[]).includes(name)) throw new Error(`Unknown option --${name.slice(0, 40)}: ${USAGE}`);
    const flag = name as Flag;
    if (raw.has(flag)) throw new Error(`Option --${flag} was given more than once`);
    let value: string | undefined;
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(`Option --${flag} needs a value`);
    raw.set(flag, value.trim());
  }
  for (const required of ['cliente', 'file', 'aparece-gente'] as const) {
    if (!raw.has(required)) throw new Error(`Option --${required} is required`);
  }

  let clienteId: ClienteId;
  try {
    clienteId = asClienteId(raw.get('cliente')!);
  } catch {
    throw new Error('Option --cliente must be a client id (UUID)');
  }
  const flagValue = raw.get('aparece-gente')!;
  if (flagValue !== 'true' && flagValue !== 'false') throw new Error('Option --aparece-gente must be true or false');
  const autorizacionId = raw.get('autorizacion');
  if (autorizacionId !== undefined && !UUID_RE.test(autorizacionId)) throw new Error('Option --autorizacion must be an authorization id (UUID)');

  const filePath = path.resolve(raw.get('file')!);
  let isFile = false;
  try {
    isFile = statSync(filePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new Error('Option --file must be the path of an existing file');

  const tagsText = raw.get('tags');
  return {
    clienteId,
    filePath,
    tags: tagsText ? tagsText.split(',').map((t) => t.trim()) : [],
    aparecenPersonas: flagValue === 'true',
    ...(autorizacionId !== undefined ? { autorizacionId } : {}),
  };
}
