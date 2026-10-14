import { usdToMicro, type MicroUsd } from '../modules/presupuesto/money.js';

export interface SetPriceArgs {
  provider: string;
  model: string;
  /** USD per million input tokens, in micro-USD. */
  inputPerMillion: MicroUsd;
  /** USD per million output tokens, in micro-USD. */
  outputPerMillion: MicroUsd;
  adminEmail: string;
  nota?: string;
}

const FLAGS = ['provider', 'model', 'input', 'output', 'admin-email', 'nota'] as const;
type Flag = (typeof FLAGS)[number];

/**
 * Accepts `--flag value` or `--flag=value` for provider, model, input, output, admin-email and
 * (optional) nota. Amounts are USD per million tokens, parsed as decimal strings with usdToMicro
 * (never through Number). Error messages name the flag and never repeat the value.
 */
export function parseSetPriceArgs(argv: readonly string[]): SetPriceArgs {
  const raw = new Map<Flag, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error('Unexpected argument: options are --provider --model --input --output --admin-email [--nota]');
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (!(FLAGS as readonly string[]).includes(name)) {
      throw new Error(`Unknown option --${name.slice(0, 40)}: options are --provider --model --input --output --admin-email [--nota]`);
    }
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
  for (const required of ['provider', 'model', 'input', 'output', 'admin-email'] as const) {
    if (!raw.has(required)) throw new Error(`Option --${required} is required`);
  }
  const amount = (flag: 'input' | 'output'): MicroUsd => {
    try {
      return usdToMicro(raw.get(flag)!);
    } catch {
      throw new Error(`Option --${flag} must be a non-negative USD amount per million tokens with at most 6 decimals`);
    }
  };
  const nota = raw.get('nota');
  return {
    provider: raw.get('provider')!,
    model: raw.get('model')!,
    inputPerMillion: amount('input'),
    outputPerMillion: amount('output'),
    adminEmail: raw.get('admin-email')!,
    ...(nota !== undefined ? { nota } : {}),
  };
}
