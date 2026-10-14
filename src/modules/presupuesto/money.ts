/** Micro-dollars: 1 USD = 1_000_000. Money is always a bigint of micro-dollars in TypeScript. */
export type MicroUsd = bigint;

export const MICRO_PER_USD = 1_000_000n;

const DECIMAL_RE = /^(\d+)(?:\.(\d{1,6}))?$/;

/** Parses a non-negative decimal USD string ("1.25", "0.000001") without touching floats. */
export function usdToMicro(value: string): MicroUsd {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) throw new Error(`Invalid USD amount: "${value}"`);
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'));
  return whole * MICRO_PER_USD + fraction;
}

/** Formats micro-dollars as a USD string with exactly six decimals (what numeric(18,6) returns). */
export function microToUsd(value: MicroUsd): string {
  if (value < 0n) throw new Error('Negative amounts are not allowed');
  const whole = value / MICRO_PER_USD;
  const fraction = (value % MICRO_PER_USD).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

/** Validates a micro-dollar amount received from a caller (integer bigint, not negative). */
export function assertMicro(value: unknown, label: string): asserts value is MicroUsd {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`${label} must be a non-negative bigint of micro-dollars`);
}
