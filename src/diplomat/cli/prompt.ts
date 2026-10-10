import { err, ok, type Result } from 'neverthrow';
import type { ZodType, ZodTypeDef } from 'zod';
import { PASSWORD_STDIN_FLAG } from '../../common/cli.js';
import { PasswordSchema, TERMINAL_SETUP_COMMAND, UsernameSchema } from '../../models/auth.js';
import type { Terminal } from './terminal.js';

/** A bad answer is asked for again this many times in all; then the command gives up. */
export const MAX_PROMPT_ATTEMPTS = 3;

export const PROMPT_MESSAGES = {
  username: 'Username: ',
  password: 'Password: ',
  confirmation: 'Confirm password: ',
  passwordsDiffer: 'The two passwords differ.',
  invalidAnswer: 'That is not valid.',
  usernameRequiredWithStdin: `--${PASSWORD_STDIN_FLAG} needs --username <name>: stdin carries only the password.`,
  noTerminal:
    'There is no terminal to ask for a password. Run this in a terminal, or pipe the password in: ' +
    `printf %s "$PASSWORD" | ${TERMINAL_SETUP_COMMAND} --username <name> --${PASSWORD_STDIN_FLAG}`,
} as const;

/** Where credentials can come from: a person at `terminal` (null when stdin is not one), or the piped password. */
export type PromptIo = {
  terminal: Terminal | null;
  readPasswordFromStdin: () => Promise<string>;
};

export type NewCredentialsOptions = { passwordStdin: boolean; username?: string };

type Answer<T> = Result<T, string>;

const decode =
  <T>(schema: ZodType<T, ZodTypeDef, string>) =>
  (raw: string): Answer<T> => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(parsed.data) : err(parsed.error.issues[0]?.message ?? PROMPT_MESSAGES.invalidAnswer);
  };

const decodeUsername = decode(UsernameSchema);
const decodePassword = decode(PasswordSchema);

/** Runs `attempt`, telling the person why and trying again after a bad answer, up to `attemptsLeft` tries in all. */
const withRetries = async <T>(
  terminal: Terminal,
  attempt: () => Promise<Answer<T>>,
  attemptsLeft = MAX_PROMPT_ATTEMPTS,
): Promise<Answer<T>> => {
  const answer = await attempt();
  if (answer.isOk() || attemptsLeft <= 1) return answer;
  terminal.tell(answer.error);
  return withRetries(terminal, attempt, attemptsLeft - 1);
};

const askUsername = (terminal: Terminal): Promise<Answer<string>> =>
  withRetries(terminal, async () => decodeUsername(await terminal.ask(PROMPT_MESSAGES.username)));

/** A new password, asked twice with no echo; a short or mismatched pair is asked for again. */
const askNewPassword = (terminal: Terminal): Promise<Answer<string>> =>
  withRetries(terminal, async () => {
    const password = decodePassword(await terminal.askSecret(PROMPT_MESSAGES.password));
    if (password.isErr()) return password;
    const confirmation = await terminal.askSecret(PROMPT_MESSAGES.confirmation);
    return confirmation === password.value ? password : err(PROMPT_MESSAGES.passwordsDiffer);
  });

const piped = async (io: PromptIo): Promise<Answer<string>> => decodePassword(await io.readPasswordFromStdin());

/** Whether this run can obtain a password at all — checked before anything is written. */
const canAskPassword = (io: PromptIo, options: Pick<NewCredentialsOptions, 'passwordStdin'>): boolean =>
  options.passwordStdin || io.terminal !== null;

/** A new password: piped with `--password-stdin`, else asked twice at the terminal. Never hangs: with neither, it
 *  fails with instructions. */
export const collectNewPassword = async (
  io: PromptIo,
  options: Pick<NewCredentialsOptions, 'passwordStdin'>,
): Promise<Answer<string>> => {
  if (options.passwordStdin) return piped(io);
  return io.terminal ? askNewPassword(io.terminal) : err(PROMPT_MESSAGES.noTerminal);
};

/** A username and a new password. With `--password-stdin` the username comes from `--username` (stdin is the
 *  password); otherwise both are asked at the terminal, the username unless it was given. */
export const collectNewCredentials = async (
  io: PromptIo,
  options: NewCredentialsOptions,
): Promise<Answer<{ username: string; password: string }>> => {
  if (options.passwordStdin && options.username === undefined) return err(PROMPT_MESSAGES.usernameRequiredWithStdin);
  if (!canAskPassword(io, options)) return err(PROMPT_MESSAGES.noTerminal);

  const username =
    options.username !== undefined
      ? decodeUsername(options.username)
      : io.terminal
        ? await askUsername(io.terminal)
        : err(PROMPT_MESSAGES.noTerminal);
  if (username.isErr()) return err(username.error);

  const password = await collectNewPassword(io, options);
  return password.map((value) => ({ username: username.value, password: value }));
};
