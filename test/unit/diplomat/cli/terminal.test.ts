import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isInteractive,
  readPasswordFromStdin,
  STDIN_IS_A_TERMINAL_MESSAGE,
} from '../../../../src/diplomat/cli/terminal.js';

const setStdinTty = (isTTY: boolean | undefined) =>
  vi.spyOn(process.stdin, 'isTTY', 'get').mockReturnValue(isTTY as boolean);

afterEach(() => vi.restoreAllMocks());

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
