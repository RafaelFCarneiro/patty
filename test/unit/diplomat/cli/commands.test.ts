import { describe, expect, it } from 'vitest';
import { runCli } from '../../../../src/diplomat/cli/commands.js';
import { EXIT_INTERRUPTED, type CliIo } from '../../../../src/diplomat/cli/io.js';
import { PromptInterruptedError, type Terminal } from '../../../../src/diplomat/cli/terminal.js';

const interruptedTerminal = (): Terminal => ({
  ask: async () => {
    throw new PromptInterruptedError();
  },
  askSecret: async () => {
    throw new PromptInterruptedError();
  },
  tell: () => undefined,
  close: () => undefined,
});

const rig = () => {
  const out: string[] = [];
  const err: string[] = [];
  let shellClosed = false;
  const io: CliIo = {
    // An owner nobody has claimed: `setup` goes on to ask for a username.
    openShell: async () =>
      ({
        deps: { users: { findById: async () => null } },
        close: () => void (shellClosed = true),
      }) as unknown as Awaited<ReturnType<CliIo['openShell']>>,
    openTerminal: interruptedTerminal,
    readPasswordFromStdin: async () => '',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    version: '0.0.0-test',
    wait: async () => undefined,
    interruptSignal: () => new AbortController().signal,
    clients: { find: () => ({ label: 'Stub', run: () => undefined }) },
  };
  return { io, out, err, shellClosed: () => shellClosed };
};

describe('Ctrl-C at a prompt', () => {
  it('ends the command with EXIT_INTERRUPTED, prints nothing more and closes the shell', async () => {
    const { io, out, err, shellClosed } = rig();
    expect(await runCli(['setup', 'claude-code'], io)).toBe(EXIT_INTERRUPTED);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(shellClosed()).toBe(true);
  });
});
