import { type ParseArgsConfig } from 'node:util';
import type { SignInHooks } from '../../../controllers/deps.js';
import { GrantChannel } from '../../../models/auth/grant.js';
import { AUTH_MESSAGES } from '../../../models/auth/message.js';
import { AUTH_ENV_VAR } from '../../../models/auth/mode.js';
import { CLI_CLIENT_NAME, TOKEN_ENV_VAR } from '../../../models/auth/signIn.js';
import {
  ObservationKind,
  PresentationKind,
  SignInStateKind,
  IDLE,
  type Presentation,
  type SignInConfig,
  type SignInObservation,
  type SignInState,
} from '../../../models/auth/signInFlow.js';
import { type TokenAccess } from '../../../models/auth/token.js';
import { NPX_COMMAND } from '../../../models/package.js';
import {
  LoginOptionsSchema,
  LogoutOptionsSchema,
  SIGN_IN_POSITIONALS,
  type LoginOptions,
} from '../../../wire/in/cli.js';
import {
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_OK,
  exitCodeOf,
  fail,
  parseFlags,
  withShell,
  type CliIo,
  type Shell,
} from '../io.js';
import { CLI_MESSAGES } from '../messages.js';
import { PromptEnd } from '../terminal.js';

export const LOGIN_MESSAGES = {
  authDisabled: `${AUTH_ENV_VAR}=disabled: stdio acts as the owner, so there is nothing to sign in to. Remove it to use sign-ins.`,
  open: (url: string, code: string) => `Open ${url} and confirm the code ${code}.`,
  waiting: 'Waiting for you to approve it in the browser… (Ctrl-C to cancel)',
  signedIn: (profile: string, access: TokenAccess, expiresAt: string) =>
    `Signed in on profile "${profile}" (${access}) until ${expiresAt}.`,
  denied: 'The sign-in was denied.',
  expired: 'The sign-in request expired before it was approved. Run the command again.',
  cancelled: 'Cancelled.',
  keychainRefused:
    'The OS keychain would not keep the sign-in, so it was revoked again. Fix keychain access, or set ' +
    `${TOKEN_ENV_VAR} in the client instead.`,
  keychainRefusedAndStillActive:
    'The OS keychain would not keep the sign-in, and it could not be revoked either: revoke it now on the Access ' +
    'page of the dashboard (/ui/access/tokens), or it stays valid until it expires.',
  keychainUnavailable:
    'the OS keychain is unavailable, so whether this profile is signed in could not be checked — unlock it and try again',
  signedOut: (profile: string) => `Signed out of profile "${profile}".`,
  notSignedIn: (profile: string) => `Not signed in on profile "${profile}".`,
  skippedNoTerminal: (profile: string) =>
    `Not signing in now (no terminal). Run \`${NPX_COMMAND} login --profile ${profile}\` when you are ready, or ` +
    'let the first tool call show a sign-in link.',
  skippedByChoice: (profile: string) =>
    `Skipped. The first tool call will show a sign-in link, or run \`${NPX_COMMAND} login --profile ${profile}\`.`,
  offer: 'Sign in this client now? [Y/n] ',
} as const;

const ANSWERED_NO = /^\s*n/i;

const O = ObservationKind.enum;
const P = PresentationKind.enum;
const S = SignInStateKind.enum;

/** Where the protocol ended up decides the exit code. */
const EXIT_CODE_OF_STATE: Readonly<Record<SignInStateKind, number>> = {
  [S.idle]: EXIT_OK,
  [S.signed_in]: EXIT_OK,
  [S.pending]: EXIT_FAILURE,
  [S.denied]: EXIT_FAILURE,
  [S.expired]: EXIT_FAILURE,
  [S.failed]: EXIT_FAILURE,
  [S.cancelled]: EXIT_INTERRUPTED,
};

/** The terminal lines for what the protocol said. A stdio-only presentation never reaches a terminal. */
const render = (io: CliIo, presentation: Presentation): void => {
  switch (presentation.kind) {
    case P.auth_disabled:
      return io.err(LOGIN_MESSAGES.authDisabled);
    case P.owner_unclaimed:
      return io.err(AUTH_MESSAGES.ownerUnclaimed);
    case P.open:
      return io.out(LOGIN_MESSAGES.open(presentation.url, presentation.code));
    case P.waiting:
      return io.out(LOGIN_MESSAGES.waiting);
    case P.signed_in:
      return io.out(LOGIN_MESSAGES.signedIn(presentation.profile, presentation.access, presentation.expiresAt));
    case P.denied:
      return io.err(LOGIN_MESSAGES.denied);
    case P.expired:
      return io.err(LOGIN_MESSAGES.expired);
    case P.cancelled:
      return io.err(LOGIN_MESSAGES.cancelled);
    case P.failed:
      return io.err(presentation.reason);
    case P.keychain_refused:
      return io.err(LOGIN_MESSAGES.keychainRefused);
    case P.keychain_refused_still_active:
      return io.err(LOGIN_MESSAGES.keychainRefusedAndStillActive);
    case P.signed_out:
      return io.out(LOGIN_MESSAGES.signedOut(presentation.profile));
    case P.not_signed_in:
      return io.out(LOGIN_MESSAGES.notSignedIn(presentation.profile));
    case P.keychain_unreadable:
      return io.err(CLI_MESSAGES.failure(LOGIN_MESSAGES.keychainUnavailable));
    case P.logout_failed:
      return io.err(CLI_MESSAGES.failure(presentation.reason));
    case P.granted:
    case P.invalid_env_token:
    case P.cannot_verify:
    case P.instructions:
      return undefined;
  }
};

const hooksFor = (io: CliIo, wait: SignInHooks['wait']): SignInHooks => ({
  present: (presentation) => render(io, presentation),
  wait,
  progress: () => undefined,
});

const configFor = (io: CliIo, shell: Shell, profile: string, hint: SignInConfig['hint']): SignInConfig => ({
  channel: GrantChannel.enum.cli,
  profile,
  client: { name: CLI_CLIENT_NAME, version: io.version },
  authRequired: shell.authRequired,
  hint,
});

/**
 * The browser sign-in from a shell (ADR-034 §3, §6): feed the protocol until it ends, printing what it says. The
 * protocol starts a grant, names the link and code, polls until it is approved, then keeps the result in the keychain
 * profile; the interpreter serves `/ui/connect` itself when no FinTrack server does. The device code and token never
 * reach the output.
 */
const signIn = async (
  io: CliIo,
  shell: Shell,
  request: { profile: string } & Pick<LoginOptions, 'duration' | 'scope'>,
): Promise<SignInState> => {
  const interrupted = io.interruptSignal();
  const interpreter = shell.signIn(request.profile);
  const config = configFor(io, shell, request.profile, { access: request.scope, duration: request.duration });
  const hooks = hooksFor(io, (ms) => io.wait(ms, interrupted));
  const feed = (state: SignInState, observation: SignInObservation) =>
    interpreter.drive(state, observation, config, hooks);
  // While a request is open the protocol is fed again each time it has finished waiting — unless Ctrl-C came.
  const untilEnded = async (state: SignInState): Promise<SignInState> =>
    state.kind === S.pending
      ? untilEnded(await feed(state, { kind: interrupted.aborted ? O.interrupted : O.ticked }))
      : state;
  try {
    return await untilEnded(await feed(IDLE, { kind: O.login_requested }));
  } finally {
    await interpreter.release();
  }
};

const LOGIN_FLAGS: ParseArgsConfig['options'] = {
  profile: { type: 'string' },
  duration: { type: 'string' },
  scope: { type: 'string' },
};
const LOGOUT_FLAGS: ParseArgsConfig['options'] = { profile: { type: 'string' } };

export const runLogin = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, LOGIN_FLAGS, LoginOptionsSchema, SIGN_IN_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const { profile, duration, scope } = parsed.options;
  return withShell(
    io,
    async (shell) =>
      EXIT_CODE_OF_STATE[(await signIn(io, shell, { profile: profile ?? shell.defaultProfile, duration, scope })).kind],
    EXIT_FAILURE,
  );
};

/** Revoke the profile's saved sign-in and forget it. Idempotent: with nothing saved it says so and succeeds. */
export const runLogout = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, LOGOUT_FLAGS, LogoutOptionsSchema, SIGN_IN_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  return withShell(
    io,
    async (shell) => {
      const profile = parsed.options.profile ?? shell.defaultProfile;
      const state = await shell.signIn(profile).drive(
        IDLE,
        { kind: O.logout_requested },
        configFor(io, shell, profile, undefined),
        hooksFor(io, async () => undefined),
      );
      return EXIT_CODE_OF_STATE[state.kind];
    },
    EXIT_FAILURE,
  );
};

/** `setup`'s last step (ADR-034 §5.3): offer to sign the client in now. Never fails the setup that wrote the config —
 *  a declined, denied or cancelled sign-in just leaves the first tool call to ask. Answers `EXIT_INTERRUPTED` after
 *  Ctrl-C at the question. */
export const offerSignIn = async (io: CliIo, profile: string): Promise<number> => {
  const terminal = io.openTerminal();
  if (terminal === null) {
    io.out(LOGIN_MESSAGES.skippedNoTerminal(profile));
    return EXIT_OK;
  }
  const answer = await terminal.ask(LOGIN_MESSAGES.offer);
  terminal.close();
  // Ctrl-D at the question is "not now"; Ctrl-C ends the command.
  if (answer.isErr() && answer.error.how === PromptEnd.enum.interrupted) return EXIT_INTERRUPTED;
  if (answer.isErr() || ANSWERED_NO.test(answer.value)) {
    io.out(LOGIN_MESSAGES.skippedByChoice(profile));
    return EXIT_OK;
  }
  const signedIn = await withShell(
    io,
    async (shell) => {
      await signIn(io, shell, { profile });
      return true;
    },
    false,
  );
  return signedIn ? EXIT_OK : EXIT_FAILURE;
};
