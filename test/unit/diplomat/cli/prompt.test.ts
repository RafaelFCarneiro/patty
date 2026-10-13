import { describe, expect, it, vi } from 'vitest';
import {
  collectNewCredentials,
  collectNewPassword,
  MAX_PROMPT_ATTEMPTS,
  PROMPT_MESSAGES,
  type PromptIo,
} from '../../../../src/diplomat/cli/prompt.js';
import type { Terminal } from '../../../../src/diplomat/cli/terminal.js';
import { PASSWORD_MIN_LENGTH } from '../../../../src/models/auth/password.js';

const GOOD_PASSWORD = 'correct horse battery staple';

type Script = { visible?: string[]; secret?: string[] };

/** A terminal that answers from a script and records what it was asked and told. */
const scriptedTerminal = (script: Script) => {
  const visible = [...(script.visible ?? [])];
  const secret = [...(script.secret ?? [])];
  const asked: string[] = [];
  const told: string[] = [];
  const next = (queue: string[]): string => {
    const answer = queue.shift();
    if (answer === undefined) throw new Error('the script ran out of answers — the code asked more than allowed');
    return answer;
  };
  const terminal: Terminal = {
    ask: async (question) => (asked.push(question), next(visible)),
    askSecret: async (question) => (asked.push(question), next(secret)),
    tell: (message) => told.push(message),
    close: () => undefined,
  };
  return { terminal, asked, told };
};

const ioFor = (
  terminal: Terminal | null,
  piped = '',
): PromptIo & { readPasswordFromStdin: ReturnType<typeof vi.fn> } => ({
  terminal,
  readPasswordFromStdin: vi.fn(async () => piped),
});

describe('collectNewCredentials at a terminal', () => {
  it('asks for the username once and the password twice, normalizing the username', async () => {
    const { terminal, asked } = scriptedTerminal({ visible: ['  Rafael '], secret: [GOOD_PASSWORD, GOOD_PASSWORD] });
    const result = await collectNewCredentials(ioFor(terminal), { passwordStdin: false });

    expect(result._unsafeUnwrap()).toEqual({ username: 'rafael', password: GOOD_PASSWORD });
    expect(asked).toEqual([PROMPT_MESSAGES.username, PROMPT_MESSAGES.password, PROMPT_MESSAGES.confirmation]);
  });

  it('never echoes: the password is asked only through askSecret', async () => {
    const { terminal } = scriptedTerminal({ visible: ['rafael'], secret: [GOOD_PASSWORD, GOOD_PASSWORD] });
    const ask = vi.spyOn(terminal, 'ask');
    await collectNewCredentials(ioFor(terminal), { passwordStdin: false });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(PROMPT_MESSAGES.username);
  });

  it('skips the username question when --username was given', async () => {
    const { terminal, asked } = scriptedTerminal({ secret: [GOOD_PASSWORD, GOOD_PASSWORD] });
    const result = await collectNewCredentials(ioFor(terminal), { passwordStdin: false, username: 'ana' });
    expect(result._unsafeUnwrap().username).toBe('ana');
    expect(asked).not.toContain(PROMPT_MESSAGES.username);
  });

  it('tells why and asks again after an invalid username, then accepts a valid one', async () => {
    const { terminal, told } = scriptedTerminal({ visible: ['ab', 'rafael'], secret: [GOOD_PASSWORD, GOOD_PASSWORD] });
    const result = await collectNewCredentials(ioFor(terminal), { passwordStdin: false });
    expect(result._unsafeUnwrap().username).toBe('rafael');
    expect(told).toEqual(['username must be at least 3 characters']);
  });

  it('gives up after the allowed number of bad usernames, telling the person each time but the last', async () => {
    const bad = Array.from({ length: MAX_PROMPT_ATTEMPTS }, () => 'x');
    const { terminal, told } = scriptedTerminal({ visible: bad });
    const result = await collectNewCredentials(ioFor(terminal), { passwordStdin: false });
    expect(result._unsafeUnwrapErr()).toBe('username must be at least 3 characters');
    expect(told).toHaveLength(MAX_PROMPT_ATTEMPTS - 1);
  });

  it('rejects a short password before asking for the confirmation, then accepts a good pair', async () => {
    const { terminal, told, asked } = scriptedTerminal({
      visible: ['rafael'],
      secret: ['short', GOOD_PASSWORD, GOOD_PASSWORD],
    });
    const result = await collectNewCredentials(ioFor(terminal), { passwordStdin: false });
    expect(result._unsafeUnwrap().password).toBe(GOOD_PASSWORD);
    expect(told).toEqual([`password must be at least ${PASSWORD_MIN_LENGTH} characters`]);
    expect(asked.filter((question) => question === PROMPT_MESSAGES.confirmation)).toHaveLength(1);
  });

  it('asks again when the two passwords differ, and gives up after the allowed tries', async () => {
    const pairs = Array.from({ length: MAX_PROMPT_ATTEMPTS }, () => [GOOD_PASSWORD, `${GOOD_PASSWORD}!`]).flat();
    const { terminal, told } = scriptedTerminal({ visible: ['rafael'], secret: pairs });
    const result = await collectNewCredentials(ioFor(terminal), { passwordStdin: false });
    expect(result._unsafeUnwrapErr()).toBe(PROMPT_MESSAGES.passwordsDiffer);
    expect(told).toEqual(Array.from({ length: MAX_PROMPT_ATTEMPTS - 1 }, () => PROMPT_MESSAGES.passwordsDiffer));
  });
});

describe('collectNewCredentials without a terminal', () => {
  it('fails with instructions, never reading stdin, with no terminal and no --password-stdin', async () => {
    const io = ioFor(null);
    const result = await collectNewCredentials(io, { passwordStdin: false });
    expect(result._unsafeUnwrapErr()).toBe(PROMPT_MESSAGES.noTerminal);
    expect(PROMPT_MESSAGES.noTerminal).toContain('--password-stdin');
    // The same words serve `auth setup`, `setup <client>` and `auth reset-password`: no command is hard-coded.
    expect(PROMPT_MESSAGES.noTerminal).not.toContain('auth setup');
    expect(io.readPasswordFromStdin).not.toHaveBeenCalled();
  });

  it('reads the piped password with --password-stdin and --username, with no terminal at all', async () => {
    const io = ioFor(null, GOOD_PASSWORD);
    const result = await collectNewCredentials(io, { passwordStdin: true, username: 'Rafael' });
    expect(result._unsafeUnwrap()).toEqual({ username: 'rafael', password: GOOD_PASSWORD });
  });

  it('needs --username with --password-stdin, because stdin carries only the password', async () => {
    const io = ioFor(null, GOOD_PASSWORD);
    const result = await collectNewCredentials(io, { passwordStdin: true });
    expect(result._unsafeUnwrapErr()).toBe(PROMPT_MESSAGES.usernameRequiredWithStdin);
    expect(io.readPasswordFromStdin).not.toHaveBeenCalled();
  });

  it('validates a piped password like a typed one, without retrying (stdin cannot be re-read)', async () => {
    const io = ioFor(null, 'short');
    const result = await collectNewCredentials(io, { passwordStdin: true, username: 'rafael' });
    expect(result._unsafeUnwrapErr()).toBe(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    expect(io.readPasswordFromStdin).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid --username before reading anything', async () => {
    const io = ioFor(null, GOOD_PASSWORD);
    const result = await collectNewCredentials(io, { passwordStdin: true, username: 'a b' });
    expect(result.isErr()).toBe(true);
    expect(io.readPasswordFromStdin).not.toHaveBeenCalled();
  });
});

describe('collectNewPassword', () => {
  it('asks twice at a terminal; with --password-stdin it ignores the terminal and reads the pipe', async () => {
    const { terminal, asked } = scriptedTerminal({ secret: [GOOD_PASSWORD, GOOD_PASSWORD] });
    expect((await collectNewPassword(ioFor(terminal), { passwordStdin: false }))._unsafeUnwrap()).toBe(GOOD_PASSWORD);
    expect(asked).toEqual([PROMPT_MESSAGES.password, PROMPT_MESSAGES.confirmation]);

    const piped = ioFor(null, GOOD_PASSWORD);
    expect((await collectNewPassword(piped, { passwordStdin: true }))._unsafeUnwrap()).toBe(GOOD_PASSWORD);
  });

  it('fails with instructions when it has nothing to ask', async () => {
    expect((await collectNewPassword(ioFor(null), { passwordStdin: false }))._unsafeUnwrapErr()).toBe(
      PROMPT_MESSAGES.noTerminal,
    );
  });
});
