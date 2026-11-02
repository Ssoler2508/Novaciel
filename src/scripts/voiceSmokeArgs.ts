import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';
import { parseFlags } from './flags.js';

export interface VoiceSmokeArgs {
  clienteId: ClienteId;
  /** A voice id of the provider's stock library to check by hand. Absent: the client's configured voice. */
  vozId?: string;
}

const USAGE = 'options are --cliente <id> [--voz <voice id>]';
const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Accepts `--cliente <uuid>` and an optional `--voz <id>`. Error messages never include a value. */
export function parseVoiceSmokeArgs(argv: readonly string[]): VoiceSmokeArgs {
  const { values } = parseFlags(argv, { values: ['cliente', 'voz'], usage: USAGE });
  const cliente = values.get('cliente');
  if (cliente === undefined) throw new Error('Option --cliente <id> is required');
  let clienteId: ClienteId;
  try {
    clienteId = asClienteId(cliente);
  } catch {
    throw new Error('Option --cliente must be a client id (UUID)');
  }
  const voz = values.get('voz');
  if (voz !== undefined && !VOICE_ID.test(voz)) throw new Error('Option --voz must be a voice id (letters, digits, "_" or "-", at most 64)');
  return { clienteId, ...(voz !== undefined ? { vozId: voz } : {}) };
}
