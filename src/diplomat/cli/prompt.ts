import { err, ok, type Result } from 'neverthrow';
import type { ZodType, ZodTypeDef } from 'zod';
import { PASSWORD_STDIN_FLAG } from '../../wire/in/cli.js';
import { PasswordSchema, UsernameSchema } from '../../models/auth/password.js';
import type { Terminal } from './terminal.js';

export const MAX_PROMPT_ATTEMPTS = 3;

export const PROMPT_MESSAGES = {
  username: 'Username: ',
  password: 'Password: ',
  confirmation: 'Confirm password: ',
  passwordsDiffer: 'The two passwords differ.',
  invalidAnswer: 'That is not valid.',
  usernameRequiredWithStdin: `--${PASSWORD_STDIN_FLAG} needs --username <name>: stdin carries only the password.`,
  noTerminal:
    'There is no terminal to ask for a password. Run this command in a terminal, or pipe the password in on ' +
    `stdin with --${PASSWORD_STDIN_FLAG} (choosing the owner's login also needs --username <name>).`,
} as const;

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

const askNewPassword = (terminal: Terminal): Promise<Answer<string>> =>
  withRetries(terminal, async () => {
    const password = decodePassword(await terminal.askSecret(PROMPT_MESSAGES.password));
    if (password.isErr()) return password;
    const confirmation = await terminal.askSecret(PROMPT_MESSAGES.confirmation);
    return confirmation === password.value ? password : err(PROMPT_MESSAGES.passwordsDiffer);
  });

const piped = async (io: PromptIo): Promise<Answer<string>> => decodePassword(await io.readPasswordFromStdin());

const canAskPassword = (io: PromptIo, options: Pick<NewCredentialsOptions, 'passwordStdin'>): boolean =>
  options.passwordStdin || io.terminal !== null;

/** Never hangs: with no pipe and no terminal it fails with instructions. */
export const collectNewPassword = async (
  io: PromptIo,
  options: Pick<NewCredentialsOptions, 'passwordStdin'>,
): Promise<Answer<string>> => {
  if (options.passwordStdin) return piped(io);
  return io.terminal ? askNewPassword(io.terminal) : err(PROMPT_MESSAGES.noTerminal);
};

const collectUsername = async (io: PromptIo, options: NewCredentialsOptions): Promise<Answer<string>> => {
  if (options.username !== undefined) return decodeUsername(options.username);
  return io.terminal ? askUsername(io.terminal) : err(PROMPT_MESSAGES.noTerminal);
};

/** With `--password-stdin` stdin is only the password, so the username must come from `--username`. */
export const collectNewCredentials = async (
  io: PromptIo,
  options: NewCredentialsOptions,
): Promise<Answer<{ username: string; password: string }>> => {
  if (options.passwordStdin && options.username === undefined) return err(PROMPT_MESSAGES.usernameRequiredWithStdin);
  if (!canAskPassword(io, options)) return err(PROMPT_MESSAGES.noTerminal);

  const username = await collectUsername(io, options);
  if (username.isErr()) return err(username.error);

  const password = await collectNewPassword(io, options);
  return password.map((value) => ({ username: username.value, password: value }));
};
