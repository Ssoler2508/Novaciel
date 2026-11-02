import { PRICE_UNITS, type NonTokenUnit } from '../modules/precios/preciosRepository.js';
import { usdToMicro, type MicroUsd } from '../modules/presupuesto/money.js';

interface SetPriceCommon {
  provider: string;
  model: string;
  adminEmail: string;
  nota?: string;
}

/** A token price: USD per million input and output tokens (the default unit). */
export interface SetTokenPriceArgs extends SetPriceCommon {
  unit: 'tokens';
  /** USD per million input tokens, in micro-USD. */
  inputPerMillion: MicroUsd;
  /** USD per million output tokens, in micro-USD. */
  outputPerMillion: MicroUsd;
}

/** A price per block of units (for example USD 0.08 per 1000 characters). */
export interface SetUnitPriceArgs extends SetPriceCommon {
  unit: NonTokenUnit;
  /** USD per block, in micro-USD. */
  pricePerBlock: MicroUsd;
  blockSize: number;
}

export type SetPriceArgs = SetTokenPriceArgs | SetUnitPriceArgs;

const USAGE = '--provider --model --admin-email [--nota] and either --input --output (tokens) or --unit <caracteres|segundos|imagenes> --price --block-size';
const FLAGS = ['provider', 'model', 'input', 'output', 'admin-email', 'nota', 'unit', 'price', 'block-size'] as const;
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
    if (!token.startsWith('--')) throw new Error('Unexpected argument: options are ' + USAGE);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (!(FLAGS as readonly string[]).includes(name)) {
      throw new Error(`Unknown option --${name.slice(0, 40)}: options are ${USAGE}`);
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
  const unitRaw = raw.get('unit') ?? 'tokens';
  if (!(PRICE_UNITS as readonly string[]).includes(unitRaw)) throw new Error(`Option --unit must be one of ${PRICE_UNITS.join(', ')}`);
  const unit = unitRaw as (typeof PRICE_UNITS)[number];
  const required = unit === 'tokens' ? (['provider', 'model', 'input', 'output', 'admin-email'] as const) : (['provider', 'model', 'price', 'block-size', 'admin-email'] as const);
  for (const flag of required) {
    if (!raw.has(flag)) throw new Error(`Option --${flag} is required`);
  }
  // Each unit uses only its own pair of options.
  const foreign = unit === 'tokens' ? (['price', 'block-size'] as const) : (['input', 'output'] as const);
  for (const flag of foreign) {
    if (raw.has(flag)) throw new Error(`Option --${flag} does not apply to --unit ${unit}`);
  }
  const amount = (flag: 'input' | 'output' | 'price'): MicroUsd => {
    try {
      return usdToMicro(raw.get(flag)!);
    } catch {
      throw new Error(`Option --${flag} must be a non-negative USD amount with at most 6 decimals`);
    }
  };
  const nota = raw.get('nota');
  const common = { provider: raw.get('provider')!, model: raw.get('model')!, adminEmail: raw.get('admin-email')!, ...(nota !== undefined ? { nota } : {}) };
  if (unit === 'tokens') return { ...common, unit, inputPerMillion: amount('input'), outputPerMillion: amount('output') };
  const blockText = raw.get('block-size')!;
  const blockSize = Number(blockText);
  if (!/^[0-9]+$/.test(blockText) || !Number.isSafeInteger(blockSize) || blockSize < 1) throw new Error('Option --block-size must be a positive integer');
  return { ...common, unit, pricePerBlock: amount('price'), blockSize };
}
