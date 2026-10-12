import { type ParseArgsConfig } from 'node:util';
import { z } from 'zod';
import { exitCodeOf, fail, parseFlags, withShell, type CliIo, type Shell } from './authCli.js';
import { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_OK, SIGN_IN_POSITIONALS } from './common/cli.js';
import { formatAppError } from './common/errors.js';
import { ownerNeedsSetup } from './controllers/auth.js';
import { revokeSignInByHash } from './controllers/accessTokens.js';
import { redeemGrant, startGrant } from './controllers/grants.js';
import { connectUrl, hasScope } from './logic/auth.js';
import {
  AUTH_ENV_VAR,
  AUTH_MESSAGES,
  CLI_CLIENT_NAME,
  GRANT_POLL_INTERVAL_MS,
  GrantChannel,
  NPX_COMMAND,
  RedeemKind,
  TOKEN_ENV_VAR,
  TokenAccess,
  WRITE_SCOPE,
  type SignedIn,
} from './models/auth.js';
import { LoginOptionsSchema, LogoutOptionsSchema, type LoginOptions } from './wire/in/cli.js';

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

/** How a sign-in attempt ended; decides the exit code. */
const SignInOutcome = z.enum(['signed_in', 'denied', 'expired', 'cancelled', 'failed']);
type SignInOutcome = z.infer<typeof SignInOutcome>;

const EXIT_CODE_OF_OUTCOME: Readonly<Record<SignInOutcome, number>> = {
  signed_in: EXIT_OK,
  denied: EXIT_FAILURE,
  expired: EXIT_FAILURE,
  cancelled: EXIT_INTERRUPTED,
  failed: EXIT_FAILURE,
};

/** Ends the sign-in with `outcome`, saying why on stderr. */
const ended = (io: CliIo, message: string, outcome: SignInOutcome): SignInOutcome => {
  io.err(message);
  return outcome;
};

const accessOf = (signedIn: SignedIn): TokenAccess =>
  hasScope(signedIn.scopes, WRITE_SCOPE) ? TokenAccess.enum.write : TokenAccess.enum.read;

/** Keep the credential in the keychain, or take it back: a sign-in nothing can find again is just a live secret. */
const keep = async (io: CliIo, shell: Shell, profile: string, signedIn: SignedIn): Promise<SignInOutcome> => {
  if (await shell.store(profile).save(signedIn.token)) {
    io.out(LOGIN_MESSAGES.signedIn(profile, accessOf(signedIn), signedIn.expiresAt));
    return SignInOutcome.enum.signed_in;
  }
  await shell.run(() => revokeSignInByHash(shell.deps, shell.deps.secrets.hashSecret(signedIn.token)));
  return ended(io, LOGIN_MESSAGES.keychainRefused, SignInOutcome.enum.failed);
};

/**
 * The browser sign-in from a shell (ADR-034 §3, §6): start a grant, print the link and code, poll until it is
 * approved, then keep the result in the keychain profile. Serves `/ui/connect` itself when no FinTrack server does.
 * The device code and token never reach the output.
 */
const signIn = async (
  io: CliIo,
  shell: Shell,
  request: { profile: string } & Pick<LoginOptions, 'duration' | 'scope'>,
): Promise<SignInOutcome> => {
  if (!shell.authRequired) return ended(io, LOGIN_MESSAGES.authDisabled, SignInOutcome.enum.failed);
  if (await ownerNeedsSetup(shell.deps)) return ended(io, AUTH_MESSAGES.ownerUnclaimed, SignInOutcome.enum.failed);

  const interrupted = io.interruptSignal();
  const server = await shell.startServer();
  try {
    const started = await shell.run(() =>
      startGrant(shell.deps, {
        client: { name: CLI_CLIENT_NAME, version: io.version },
        profile: request.profile,
        channel: GrantChannel.enum.cli,
        hint: { access: request.scope, duration: request.duration },
      }),
    );
    if (started.isErr()) return ended(io, formatAppError(started.error), SignInOutcome.enum.failed);

    io.out(LOGIN_MESSAGES.open(connectUrl(server.origin, started.value.userCode), started.value.userCode));
    io.out(LOGIN_MESSAGES.waiting);

    for (;;) {
      if (interrupted.aborted) return ended(io, LOGIN_MESSAGES.cancelled, SignInOutcome.enum.cancelled);
      const redeemed = await shell.run(() => redeemGrant(shell.deps, started.value.deviceCode));
      if (redeemed.isErr()) return ended(io, formatAppError(redeemed.error), SignInOutcome.enum.failed);
      switch (redeemed.value.kind) {
        case RedeemKind.enum.signed_in:
          return keep(io, shell, request.profile, redeemed.value);
        case RedeemKind.enum.denied:
          return ended(io, LOGIN_MESSAGES.denied, SignInOutcome.enum.denied);
        case RedeemKind.enum.expired:
        case RedeemKind.enum.invalid:
          return ended(io, LOGIN_MESSAGES.expired, SignInOutcome.enum.expired);
        case RedeemKind.enum.pending:
          await io.wait(GRANT_POLL_INTERVAL_MS, interrupted);
      }
    }
  } finally {
    await server.close();
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
      EXIT_CODE_OF_OUTCOME[await signIn(io, shell, { profile: profile ?? shell.defaultProfile, duration, scope })],
  );
};

/** Revoke the profile's saved sign-in and forget it. Idempotent: with nothing saved it says so and succeeds. */
export const runLogout = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, LOGOUT_FLAGS, LogoutOptionsSchema, SIGN_IN_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  return withShell(io, async (shell) => {
    const profile = parsed.options.profile ?? shell.defaultProfile;
    const store = shell.store(profile);
    const token = await store.load();
    if (token === null) {
      io.out(LOGIN_MESSAGES.notSignedIn(profile));
      return EXIT_OK;
    }
    const revoked = await shell.run(() => revokeSignInByHash(shell.deps, shell.deps.secrets.hashSecret(token)));
    if (revoked.isErr()) return exitCodeOf(fail(io, formatAppError(revoked.error)));
    // Another process may have saved a newer sign-in since `load()`: only remove the entry if it is still this one.
    if ((await store.load()) === token) await store.clear();
    io.out(LOGIN_MESSAGES.signedOut(profile));
    return EXIT_OK;
  });
};

/** `setup`'s last step (ADR-034 §5.3): offer to sign the client in now. Never fails the setup that wrote the config —
 *  a declined, denied or cancelled sign-in just leaves the first tool call to ask. */
export const offerSignIn = async (io: CliIo, profile: string): Promise<void> => {
  const terminal = io.openTerminal();
  if (terminal === null) {
    io.out(LOGIN_MESSAGES.skippedNoTerminal(profile));
    return;
  }
  let declined = true;
  try {
    declined = ANSWERED_NO.test(await terminal.ask(LOGIN_MESSAGES.offer));
  } catch {
    // Ctrl-D at the question: treated as "not now".
  } finally {
    terminal.close();
  }
  if (declined) {
    io.out(LOGIN_MESSAGES.skippedByChoice(profile));
    return;
  }
  await withShell(io, (shell) => signIn(io, shell, { profile }));
};
