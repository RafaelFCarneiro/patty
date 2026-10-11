import { afterEach, describe, expect, it } from 'vitest';
import {
  isInteractive,
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
