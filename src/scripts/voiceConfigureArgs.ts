import { asClienteId, type ClienteId } from '../modules/shared/clienteId.js';
import { parseFlags } from './flags.js';

export interface VoiceConfigureArgs {
  clienteId: ClienteId;
  adminEmail: string;
  /** Turn the voice off, keeping the rest of its settings. Mutually exclusive with --voz. */
  desactivar: boolean;
  vozId?: string;
  idioma?: string;
  estabilidad?: number;
  similitud?: number;
  estilo?: number;
  velocidad?: number;
}

const USAGE = 'options are --cliente <id> --admin-email <email> (--voz <voice id> --idioma <xx> [--velocidad n] [--estabilidad n] [--similitud n] [--estilo n] | --desactivar)';
const NUMBERS = ['velocidad', 'estabilidad', 'similitud', 'estilo'] as const;

/** Error messages name the option and never repeat its value. */
export function parseVoiceConfigureArgs(argv: readonly string[]): VoiceConfigureArgs {
  const { values, switches } = parseFlags(argv, { values: ['cliente', 'admin-email', 'voz', 'idioma', ...NUMBERS], switches: ['desactivar'], usage: USAGE });
  const cliente = values.get('cliente');
  if (cliente === undefined) throw new Error('Option --cliente <id> is required');
  let clienteId: ClienteId;
  try {
    clienteId = asClienteId(cliente);
  } catch {
    throw new Error('Option --cliente must be a client id (UUID)');
  }
  const adminEmail = values.get('admin-email');
  if (adminEmail === undefined) throw new Error('Option --admin-email is required');
  const desactivar = switches.has('desactivar');
  const args: VoiceConfigureArgs = { clienteId, adminEmail, desactivar };
  if (desactivar) {
    for (const flag of ['voz', 'idioma', ...NUMBERS]) if (values.has(flag)) throw new Error(`Option --${flag} does not apply with --desactivar`);
    return args;
  }
  const voz = values.get('voz');
  const idioma = values.get('idioma');
  if (voz === undefined) throw new Error('Option --voz <voice id> is required (or use --desactivar)');
  if (idioma === undefined) throw new Error('Option --idioma <xx> is required');
  args.vozId = voz;
  args.idioma = idioma;
  for (const flag of NUMBERS) {
    const raw = values.get(flag);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!/^[0-9]+(\.[0-9]+)?$/.test(raw) || !Number.isFinite(n)) throw new Error(`Option --${flag} must be a plain non-negative number`);
    args[flag] = n;
  }
  return args;
}
