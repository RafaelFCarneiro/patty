import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isInteractive,
  open,
  readPasswordFromStdin,
  STDIN_IS_A_TERMINAL_MESSAGE,
} from '../../../../src/diplomat/cli/terminal.js';

const originalIsTty = process.stdin.isTTY;
const setStdinTty = (isTTY: boolean | undefined): void => {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true, writable: true });
};

afterEach(() => setStdinTty(originalIsTty));

describe('readPasswordFromStdin', () => {
  it('refuses a terminal on stdin instead of waiting for typed input', async () => {
    setStdinTty(true);
    await expect(readPasswordFromStdin()).rejects.toThrow(STDIN_IS_A_TERMINAL_MESSAGE);
    expect(STDIN_IS_A_TERMINAL_MESSAGE).toContain('--password-stdin');
  });
});

describe('isInteractive', () => {
  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])('stdin isTTY=%s → %s', (isTTY, expected) => {
    setStdinTty(isTTY);
    expect(isInteractive()).toBe(expected);
  });
});

describe('open', () => {
  const rig = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString()));
    const terminal = open({ input, output });
    const typed = (line: string) => void setImmediate(() => input.write(`${line}\n`));
    return { terminal, typed, shown: () => written.join('') };
  };

  it('shows the prompt of a secret question and swallows what is typed in answer', async () => {
    const { terminal, typed, shown } = rig();
    const answered = terminal.askSecret('Password: ');
    typed('hunter2');

    expect((await answered)._unsafeUnwrap()).toBe('hunter2');
    expect(shown()).toContain('Password: ');
    expect(shown()).not.toContain('hunter2');
    terminal.close();
  });

  it('asks a visible question normally after a secret one', async () => {
    const { terminal, typed, shown } = rig();
    const secret = terminal.askSecret('Password: ');
    typed('hunter2');
    await secret;

    const visible = terminal.ask('Username: ');
    typed('rafael');
    expect((await visible)._unsafeUnwrap()).toBe('rafael');
    expect(shown()).toContain('Username: ');
    expect(shown()).not.toContain('hunter2');
    terminal.close();
  });

  it('reads a question asked on a closed terminal as the prompt having ended, not a crash', async () => {
    const { terminal } = rig();
    terminal.close();
    expect((await terminal.ask('Username: '))._unsafeUnwrapErr()).toMatchObject({ code: 'prompt_ended' });
    expect((await terminal.askSecret('Password: '))._unsafeUnwrapErr()).toMatchObject({ code: 'prompt_ended' });
  });
});
