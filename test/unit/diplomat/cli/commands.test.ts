import { errAsync, ok, okAsync } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../../../src/diplomat/cli/commands.js';
import { EXIT_FAILURE, EXIT_INTERRUPTED, type CliIo, type Shell } from '../../../../src/diplomat/cli/io.js';
import { promptEnded, type PromptEnd, type Terminal } from '../../../../src/diplomat/cli/terminal.js';
import { databaseAheadMessage, databaseErrors } from '../../../../src/models/database.js';

const endedTerminal = (how: PromptEnd): Terminal => ({
  ask: () => errAsync(promptEnded(how)),
  askSecret: () => errAsync(promptEnded(how)),
  tell: () => undefined,
  close: () => undefined,
});

const rig = (terminal: Terminal) => {
  const out: string[] = [];
  const err: string[] = [];
  let shellClosed = false;
  const io: CliIo = {
    // An owner nobody has claimed: `setup` goes on to ask for a username.
    openShell: () =>
      okAsync({
        deps: { users: { findById: async () => null } },
        close: () => void (shellClosed = true),
      } as unknown as Shell),
    openTerminal: () => terminal,
    readPasswordFromStdin: async () => '',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    version: '0.0.0-test',
    wait: async () => undefined,
    interruptSignal: () => new AbortController().signal,
    clients: { find: () => ({ label: 'Stub', run: () => ok({ warnings: [], lines: [] }) }) },
  };
  return { io, out, err, shellClosed: () => shellClosed };
};

describe('a prompt that ends', () => {
  it('Ctrl-C ends the command with EXIT_INTERRUPTED, prints nothing more and closes the shell', async () => {
    const { io, out, err, shellClosed } = rig(endedTerminal('interrupted'));
    expect(await runCli(['setup', 'claude-code'], io)).toBe(EXIT_INTERRUPTED);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(shellClosed()).toBe(true);
  });

  it('Ctrl-D is a failure with today’s one-line "cancelled" message', async () => {
    const { io, out, err, shellClosed } = rig(endedTerminal('cancelled'));
    expect(await runCli(['setup', 'claude-code'], io)).toBe(EXIT_FAILURE);
    expect(out).toEqual([]);
    expect(err).toEqual(['fintrack: cancelled']);
    expect(shellClosed()).toBe(true);
  });
});

describe('a prompt that ends in the auth commands', () => {
  it.each([
    ['interrupted', EXIT_INTERRUPTED, []],
    ['cancelled', EXIT_FAILURE, ['fintrack: cancelled']],
  ] as const)('auth setup and auth reset-password: %s → exit %i', async (how, code, expectedErr) => {
    for (const args of [
      ['auth', 'setup'],
      ['auth', 'reset-password'],
    ]) {
      const { io, err } = rig(endedTerminal(how));
      if (args[1] === 'reset-password') {
        io.openShell = () =>
          okAsync({
            deps: { users: { findById: async () => ({ id: 'user-owner', username: 'rafael', version: 1 }) } },
            close: () => undefined,
          } as unknown as Shell);
      }
      expect(await runCli(args, io), args.join(' ')).toBe(code);
      expect(err, args.join(' ')).toEqual(expectedErr);
    }
  });
});

describe('a database a newer build has migrated', () => {
  it('says the one message on stderr and fails, for every command that opens the database', async () => {
    for (const args of [['auth', 'setup'], ['login'], ['logout'], ['setup', 'claude-code']]) {
      const { io, out, err } = rig(endedTerminal('cancelled'));
      io.openShell = () => errAsync(databaseErrors.ahead('1.2.3'));
      expect(await runCli(args, io), args.join(' ')).toBe(EXIT_FAILURE);
      expect(out).toEqual([]);
      expect(err).toEqual([databaseAheadMessage('1.2.3')]);
    }
  });
});
