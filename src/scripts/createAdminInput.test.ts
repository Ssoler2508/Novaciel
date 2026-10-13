import { describe, expect, it } from 'vitest';
import { parseCreateAdminArgs } from './createAdminArgs.js';
import { applyKeys, firstLine, type KeyState } from './passwordInput.js';

describe('parseCreateAdminArgs', () => {
  it('accepts --email and --nombre in both forms', () => {
    expect(parseCreateAdminArgs(['--email', 'a@example.test', '--nombre', 'Ana Ficticia'])).toEqual({
      email: 'a@example.test',
      nombre: 'Ana Ficticia',
    });
    expect(parseCreateAdminArgs(['--email=a@example.test'])).toEqual({ email: 'a@example.test' });
    expect(parseCreateAdminArgs([])).toEqual({});
  });

  it.each([['--password'], ['--password=hunter2hunter2'], ['--PASS'], ['--contrasena']])(
    'refuses %s and never echoes the value',
    (arg) => {
      const argv = arg.includes('=') ? [arg] : [arg, 'hunter2hunter2'];
      let message = '';
      try {
        parseCreateAdminArgs(argv);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/never accepted as an argument/);
      expect(message).not.toContain('hunter2');
    },
  );

  it('refuses unknown options, positional arguments and missing values', () => {
    expect(() => parseCreateAdminArgs(['--role', 'x'])).toThrow(/Unknown option/);
    expect(() => parseCreateAdminArgs(['a@example.test'])).toThrow(/Unexpected argument/);
    expect(() => parseCreateAdminArgs(['--email'])).toThrow(/needs a value/);
    expect(() => parseCreateAdminArgs(['--email', '--nombre', 'x'])).toThrow(/needs a value/);
  });
});

describe('password input handling', () => {
  const type = (...chunks: string[]) => {
    const state: KeyState = { value: '' };
    let outcome = 'continue';
    for (const chunk of chunks) {
      outcome = applyKeys(state, chunk);
      if (outcome !== 'continue') break;
    }
    return { value: state.value, outcome };
  };

  it('collects characters until Enter', () => {
    expect(type('a', 'b', 'c', '\r')).toEqual({ value: 'abc', outcome: 'enter' });
    expect(type('abc\n')).toEqual({ value: 'abc', outcome: 'enter' });
  });

  it('handles Backspace, pasted chunks and ignores other control keys', () => {
    expect(type('abc', '\u007f', 'd\r')).toEqual({ value: 'abd', outcome: 'enter' });
    expect(type('ab', '\b\b\b', 'x', '\r')).toEqual({ value: 'x', outcome: 'enter' });
    expect(type('a\u001b[Ab\r').value).toBe('a[Ab');
  });

  it('Ctrl-C aborts; Ctrl-D submits only when something was typed', () => {
    expect(type('abc', '\u0003').outcome).toBe('abort');
    expect(type('abc', '\u0004').outcome).toBe('enter');
    expect(type('\u0004').outcome).toBe('abort');
  });

  it('takes the first line of piped input without the line ending', () => {
    expect(firstLine('s3cret password\r\nsecond line')).toBe('s3cret password');
    expect(firstLine('only line')).toBe('only line');
    expect(firstLine('')).toBe('');
  });
});
