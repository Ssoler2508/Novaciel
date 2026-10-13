import { inspect } from 'node:util';

/**
 * A secret string that never shows up by accident: JSON.stringify, pino and util.inspect print a
 * placeholder. The value is only reachable through reveal(), at the point of use.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON() {
    return '[REDACTED]';
  }

  toString() {
    return '[REDACTED]';
  }

  [inspect.custom]() {
    return '[REDACTED]';
  }
}
