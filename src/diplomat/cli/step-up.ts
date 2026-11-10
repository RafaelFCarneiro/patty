import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { guardClaimedAdminExists, confirmKeyExportAdmin } from '../../controllers/auth/key-export.js';
import type { KeyExportDeps, StepUpSecrets } from '../../controllers/deps.js';
import { authErrors } from '../../models/auth/errors.js';
import {
  EXPORT_DECLINED,
  type AdminCredentials,
  type KeyExportError,
  type KeyExportStop,
} from '../../models/auth/key-export.js';
import { AUTH_MESSAGES } from '../../models/auth/message.js';
import { CLI_MESSAGES } from './messages.js';
import { exitCodeOfPrompt, failed, type CliIo } from './io.js';
import {
  askAdminCredentials,
  askConfirmation,
  MAX_PROMPT_ATTEMPTS,
  PROMPT_MESSAGES,
  type PromptFailure,
} from './prompt.js';
import { PromptFailureCode, type Terminal } from './terminal.js';

export type StepUpFailure = PromptFailure | KeyExportStop;

type StepUpContext = {
  terminal: Terminal;
  confirm: (credentials: AdminCredentials) => ResultAsync<unknown, KeyExportError>;
  pause: () => Promise<void>;
};

const isWrongAnswer = (failure: StepUpFailure): boolean => failure.code === authErrors.invalidCredentials.code;

/** A wrong answer is told, followed by a fixed pause, and asked again — at most `MAX_PROMPT_ATTEMPTS` times in all.
 *  Anything else (the prompt ending, the database unreadable) stops at once. */
const askUntilConfirmed = (context: StepUpContext, attemptsLeft: number): ResultAsync<void, StepUpFailure> =>
  askAdminCredentials(context.terminal)
    .andThen(context.confirm)
    .map(() => undefined)
    .orElse((failure: StepUpFailure) => {
      if (!isWrongAnswer(failure) || attemptsLeft <= 1) return errAsync(failure);
      context.terminal.tell(AUTH_MESSAGES.invalidCredentials);
      return ResultAsync.fromSafePromise(context.pause()).andThen(() => askUntilConfirmed(context, attemptsLeft - 1));
    });

type KeyExportApproval = {
  terminal: Terminal;
  users: KeyExportDeps['users'];
  secrets: () => Promise<StepUpSecrets>;
  pause: () => Promise<void>;
  destination: string;
};

const confirmWarning = (terminal: Terminal, destination: string): ResultAsync<void, StepUpFailure> => {
  terminal.tell(CLI_MESSAGES.keyExportWarning(destination));
  return askConfirmation(terminal, PROMPT_MESSAGES.exportConfirmation).andThen((confirmed) =>
    confirmed ? okAsync(undefined) : errAsync(EXPORT_DECLINED),
  );
};

/** Everything that must hold before the key is written: an administrator with a login exists, one of them proved it
 *  with their password, and the person confirmed the warning. Writes nothing. */
export const approveKeyExport = ({
  terminal,
  users,
  secrets,
  pause,
  destination,
}: KeyExportApproval): ResultAsync<void, StepUpFailure> =>
  guardClaimedAdminExists({ users })
    .andThen(() => ResultAsync.fromSafePromise(secrets()))
    .andThen((loaded) => {
      const deps: KeyExportDeps = { users, secrets: loaded };
      return askUntilConfirmed(
        { terminal, pause, confirm: (credentials) => confirmKeyExportAdmin(deps, credentials) },
        MAX_PROMPT_ATTEMPTS,
      );
    })
    .andThen(() => confirmWarning(terminal, destination));

const isPromptFailure = (failure: StepUpFailure): failure is PromptFailure =>
  PromptFailureCode.safeParse(failure.code).success;

/** What a refused export answers: a prompt that ended or was invalid as every command does, anything else in words. */
export const exitCodeOfStop = (io: CliIo, failure: StepUpFailure): number =>
  isPromptFailure(failure) ? exitCodeOfPrompt(io, failure) : failed(io, CLI_MESSAGES.keyExportStopped(failure));
