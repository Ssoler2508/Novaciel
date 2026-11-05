import { parseFlags } from './flags.js';
import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';

// Arguments of the Step 10 development scripts. Error messages name the option and never repeat its value.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(values: ReadonlyMap<string, string>, name: string, label: string): string {
  const value = values.get(name);
  if (value === undefined) throw new Error(`Option --${name} <id> is required`);
  if (!UUID_RE.test(value)) throw new Error(`Option --${name} must be a ${label} id (UUID)`);
  return value;
}

export interface PiezaArgs {
  clienteId: ClienteId;
  piezaId: string;
}

function piezaArgs(argv: readonly string[], usage: string): PiezaArgs {
  const { values } = parseFlags(argv, { values: ['cliente', 'pieza'], usage });
  return { clienteId: asClienteId(uuid(values, 'cliente', 'client')), piezaId: uuid(values, 'pieza', 'piece') };
}

export interface PieceScheduleArgs extends PiezaArgs {
  at: Date;
}
export function parsePieceScheduleArgs(argv: readonly string[]): PieceScheduleArgs {
  const usage = 'options are --cliente <id> --pieza <id> --at <ISO 8601>';
  const { values } = parseFlags(argv, { values: ['cliente', 'pieza', 'at'], usage });
  const raw = values.get('at');
  if (raw === undefined) throw new Error('Option --at <ISO 8601> is required');
  // A date with an explicit offset or Z: "2026-11-10T15:00:00-05:00".
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new Error('Option --at must be an ISO 8601 date and time with an offset or Z');
  }
  return { clienteId: asClienteId(uuid(values, 'cliente', 'client')), piezaId: uuid(values, 'pieza', 'piece'), at: new Date(raw) };
}

export const parsePiecePublishArgs = (argv: readonly string[]): PiezaArgs => piezaArgs(argv, 'options are --cliente <id> --pieza <id>');
export const parsePublishMetricsArgs = (argv: readonly string[]): PiezaArgs => piezaArgs(argv, 'options are --cliente <id> --pieza <id>');
