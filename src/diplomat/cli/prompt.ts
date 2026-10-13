import { err, errAsync, ok, safeTry, type Result, type ResultAsync } from 'neverthrow';
import type { ZodType, ZodTypeDef } from 'zod';
import { PASSWORD_STDIN_FLAG } from '../../wire/in/cli.js';
import { PasswordSchema, UsernameSchema } from '../../models/auth/password.js';
import type { PromptEnded, Terminal } from './terminal.js';

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

/** A decoded answer, or why it is not valid. */
type Answer<T> = Result<T, string>;

/** Why asking failed: an answer that is not valid (its message), or the prompt ended before one came. */
export type PromptFailure = string | PromptEnded;
export const isPromptEnded = (failure: PromptFailure): failure is PromptEnded => typeof failure !== 'string';

type Asked<T> = ResultAsync<T, PromptFailure>;

const decode =
  <T>(schema: ZodType<T, ZodTypeDef, string>) =>
  (raw: string): Answer<T> => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(parsed.data) : err(parsed.error.issues[0]?.message ?? PROMPT_MESSAGES.invalidAnswer);
  };

const decodeUsername = decode(UsernameSchema);
const decodePassword = decode(PasswordSchema);

/** An invalid answer is asked again (and told why) until the attempts run out; an ended prompt is never retried. */
const withRetries = <T>(terminal: Terminal, attempt: () => Asked<T>, attemptsLeft = MAX_PROMPT_ATTEMPTS): Asked<T> =>
  attempt().orElse((failure) => {
    if (isPromptEnded(failure) || attemptsLeft <= 1) return errAsync(failure);
    terminal.tell(failure);
    return withRetries(terminal, attempt, attemptsLeft - 1);
  });

const askUsername = (terminal: Terminal): Asked<string> =>
  withRetries(terminal, () => terminal.ask(PROMPT_MESSAGES.username).andThen(decodeUsername));

const askNewPassword = (terminal: Terminal): Asked<string> =>
  withRetries(terminal, () =>
    safeTry(async function* () {
      const password = yield* terminal.askSecret(PROMPT_MESSAGES.password).andThen(decodePassword);
      const confirmation = yield* terminal.askSecret(PROMPT_MESSAGES.confirmation);
      return confirmation === password ? ok(password) : err(PROMPT_MESSAGES.passwordsDiffer);
    }),
  );

const piped = async (io: PromptIo): Promise<Result<string, PromptFailure>> =>
  decodePassword(await io.readPasswordFromStdin());

const canAskPassword = (io: PromptIo, options: Pick<NewCredentialsOptions, 'passwordStdin'>): boolean =>
  options.passwordStdin || io.terminal !== null;

/** Never hangs: with no pipe and no terminal it fails with instructions. */
export const collectNewPassword = async (
  io: PromptIo,
  options: Pick<NewCredentialsOptions, 'passwordStdin'>,
): Promise<Result<string, PromptFailure>> => {
  if (options.passwordStdin) return piped(io);
  return io.terminal ? askNewPassword(io.terminal) : err(PROMPT_MESSAGES.noTerminal);
};

const collectUsername = async (
  io: PromptIo,
  options: NewCredentialsOptions,
): Promise<Result<string, PromptFailure>> => {
  if (options.username !== undefined) return decodeUsername(options.username);
  return io.terminal ? askUsername(io.terminal) : err(PROMPT_MESSAGES.noTerminal);
};

/** With `--password-stdin` stdin is only the password, so the username must come from `--username`. */
export const collectNewCredentials = async (
  io: PromptIo,
  options: NewCredentialsOptions,
): Promise<Result<{ username: string; password: string }, PromptFailure>> => {
  if (options.passwordStdin && options.username === undefined) return err(PROMPT_MESSAGES.usernameRequiredWithStdin);
  if (!canAskPassword(io, options)) return err(PROMPT_MESSAGES.noTerminal);

  const username = await collectUsername(io, options);
  if (username.isErr()) return err(username.error);

  const password = await collectNewPassword(io, options);
  return password.map((value) => ({ username: username.value, password: value }));
};
