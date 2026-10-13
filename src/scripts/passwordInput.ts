import { createInterface } from 'node:readline/promises';

// Password input for create-admin. A password only ever comes from a hidden prompt on a terminal
// or from stdin: never from arguments or the environment, and it is never printed.

export interface KeyState {
  value: string;
}
export type KeyOutcome = 'continue' | 'enter' | 'abort';

/** Applies one chunk of raw keystrokes to the typed value. Pure, so it can be tested without a terminal. */
export function applyKeys(state: KeyState, chunk: string): KeyOutcome {
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') return 'enter';
    if (ch === '\u0003') return 'abort'; // Ctrl-C
    if (ch === '\u0004') return state.value.length > 0 ? 'enter' : 'abort'; // Ctrl-D
    if (ch === '\b' || ch === '\u007f') state.value = Array.from(state.value).slice(0, -1).join('');
    else if (ch >= ' ') state.value += ch; // printable; other control keys are ignored
  }
  return 'continue';
}

/** First line of piped input, without the line ending. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    const state: KeyState = { value: '' };
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      const outcome = applyKeys(state, chunk);
      if (outcome === 'continue') return;
      finish();
      if (outcome === 'abort') reject(new Error('Cancelled'));
      else resolve(state.value);
    };
    stdin.on('data', onData);
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** Hidden prompt (asked twice) on a terminal; first line of stdin otherwise. */
export async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await readHidden('Password (hidden): ');
    const second = await readHidden('Repeat password: ');
    if (first !== second) throw new Error('Passwords do not match');
    return first;
  }
  const password = firstLine(await readAllStdin());
  if (!password) throw new Error('No password received on stdin');
  return password;
}

/** Visible prompt for non-secret values such as the email. Terminal only. */
export async function askVisible(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${question.trim()} is required: pass it as an option`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
