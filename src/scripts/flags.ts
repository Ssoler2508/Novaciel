// A small parser for the development scripts: `--flag value` or `--flag=value`, and `--switch` with no value.
// Error messages name the option and never repeat its value.

export interface FlagSpec {
  /** Options that take a value. */
  values: readonly string[];
  /** Options that stand alone (true when present). */
  switches?: readonly string[];
  /** Appended to errors about unexpected arguments. */
  usage: string;
}

export interface ParsedFlags {
  values: ReadonlyMap<string, string>;
  switches: ReadonlySet<string>;
}

export function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedFlags {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const known = [...spec.values, ...(spec.switches ?? [])];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${spec.usage}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (!known.includes(name)) throw new Error(`Unknown option --${name.slice(0, 40)}: ${spec.usage}`);
    if ((spec.switches ?? []).includes(name)) {
      if (eq !== -1) throw new Error(`Option --${name} takes no value`);
      if (switches.has(name)) throw new Error(`Option --${name} was given more than once`);
      switches.add(name);
      continue;
    }
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
  return { values, switches };
}
