export interface CreateAdminArgs {
  email?: string;
  nombre?: string;
}

const PASSWORD_LIKE = /^(password|pass|passwd|pwd|contrasena|clave|secret)$/i;

/**
 * Accepts only --email and --nombre (as `--flag value` or `--flag=value`). A password is never
 * accepted as an argument. Error messages never include argument values.
 */
export function parseCreateAdminArgs(argv: readonly string[]): CreateAdminArgs {
  const out: CreateAdminArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error('Unexpected argument: only --email and --nombre are accepted');
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (PASSWORD_LIKE.test(name)) {
      throw new Error('Refused: a password is never accepted as an argument; type it at the prompt or pipe it through stdin');
    }
    if (name !== 'email' && name !== 'nombre') {
      throw new Error(`Unknown option --${name.slice(0, 40)}: only --email and --nombre are accepted`);
    }
    let value: string | undefined;
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw new Error(`Option --${name} needs a value`);
    }
    out[name] = value.trim();
  }
  return out;
}
