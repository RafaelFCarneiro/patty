import { z } from 'zod';
import { KeychainUnavailableError } from '../../common/keychain.js';
import { authenticateToken, revokeSignInByHash } from '../../controllers/accessTokens.js';
import type { AuthDeps, RunEffects, SignInServer, SignInStore } from '../../controllers/deps.js';
import { ownerNeedsSetup } from '../../controllers/auth.js';
import { redeemGrant, startGrant } from '../../controllers/grants.js';
import { persistsToKeychain } from '../../logic/auth/grant.js';
import { notSignedInMessage } from '../../logic/auth/message.js';
import { isTokenShaped } from '../../logic/auth/token.js';
import { type ClientInfo, GrantChannel, RedeemKind, type SignedIn } from '../../models/auth/grant.js';
import { STDIO_MESSAGES } from '../../models/auth/message.js';
import { type Principal, PrincipalVia } from '../../models/auth/principal.js';
import { GRANT_POLL_INTERVAL_MS } from '../../models/auth/signIn.js';
import { clientInfoOf } from '../../wire/in/auth.js';
import { GateKind, type GateOutcome } from './gate.js';

/**
 * The stdio channel's identity (ADR-034 §2, §4). A stdio process is spawned by whichever program the user pointed at
 * it, so it acts as nobody until it holds a credential, and it holds exactly one, found in this order:
 *   1. `FINTRACK_TOKEN` from the environment — a failure here is an error, never a reason to try the next source;
 *   2. the sign-in saved in the OS keychain for this profile and database;
 *   3. none: it asks for one (a pending grant the person approves in the browser) and answers every gated request
 *      with the instructions to do so.
 * The credential is re-validated on EVERY gated request through the same `authenticateToken` the HTTP edge uses, so a
 * revocation or an expiry takes effect on the very next call. Thin by design: which message, which scope and which
 * duration persists are `logic/auth.ts`'s decisions; this file only sequences I/O.
 */
export type StdioSession = {
  /** Who the next gated request acts as — or why nobody. */
  resolve: () => Promise<GateOutcome>;
  /** Stop polling and, for a "this session only" sign-in, revoke it (best effort; the 12-hour cap covers a crash). */
  close: () => Promise<void>;
};

export type StdioSessionOptions = {
  deps: AuthDeps;
  /** Already adapted model→row (`bindAuthRunEffects`). */
  run: RunEffects;
  profile: string;
  envToken: string | undefined;
  store: SignInStore;
  /** The origin of a page this process can honestly name for `/ui/connect` — `PUBLIC_URL`, or the sidecar it bound — or
   *  `null`. Asked at use, because the sidecar binds after the session exists. */
  origin: () => string | null;
  /** How to serve `/ui/connect` when `origin()` names nothing: a temporary app of this process, on this database.
   *  Absent when there is no HTTP at all (`FINTRACK_HTTP=false`): the message points to `login` / `FINTRACK_TOKEN`. */
  temporaryServer?: () => Promise<SignInServer>;
  /** What the MCP client reported in `initialize` (`undefined` before it has). */
  clientInfo: () => unknown;
};

type Held = {
  token: string;
  principal: Principal;
  /** A "this session only" sign-in: it exists in this process's memory alone, never reaches the keychain, and is
   *  revoked when the process closes. */
  ephemeral: boolean;
};

type Pending = { deviceCode: string; userCode: string };

/** What looking a credential up came to: usable, rejected, or "could not tell" (the lookup itself failed). */
const CheckKind = z.enum(['ok', 'invalid', 'failure']);
type Checked =
  | { kind: typeof CheckKind.enum.ok; principal: Principal }
  | { kind: typeof CheckKind.enum.invalid }
  | { kind: typeof CheckKind.enum.failure };

/** Where redeeming the pending request stands: signed in, still waiting, or no request left (answered or expired). */
const RedemptionKind = z.enum(['signed_in', 'pending', 'gone']);

const granted = (principal: Principal): GateOutcome => ({ kind: GateKind.enum.granted, principal });
const notSignedIn = (message: string): GateOutcome => ({ kind: GateKind.enum.not_signed_in, message });

export const createStdioSession = (options: StdioSessionOptions): StdioSession => {
  const { deps, run, store } = options;
  let held: Held | null = null;
  let pending: Pending | null = null;
  let timer: NodeJS.Timeout | null = null;
  let temporary: SignInServer | null = null;

  // Requests and the poll timer share `held`/`pending`, and a device code is single-use: one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  const check = async (token: string): Promise<Checked> => {
    const result = await run(() => authenticateToken(deps, deps.secrets.hashSecret(token), PrincipalVia.enum.stdio));
    if (result.isErr()) return { kind: CheckKind.enum.failure };
    return result.value === null
      ? { kind: CheckKind.enum.invalid }
      : { kind: CheckKind.enum.ok, principal: result.value };
  };

  const stopPolling = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  /** The temporary page lives as long as the request it serves: closed once it is redeemed, denied or expired. */
  const closeTemporaryServer = async (): Promise<void> => {
    const server = temporary;
    temporary = null;
    await server?.close().catch(() => undefined);
  };

  const adopt = async (signedIn: SignedIn): Promise<Held> => {
    // A sign-in the keychain would not keep lives in memory alone, so like "this session only" it is revoked at close.
    const ephemeral = !persistsToKeychain(signedIn.duration) || !(await store.save(signedIn.token));
    held = { token: signedIn.token, principal: signedIn.principal, ephemeral };
    pending = null;
    stopPolling();
    await closeTemporaryServer();
    return held;
  };

  /** Drop a credential that turned out unusable. The keychain entry goes too — but only if it still holds this very
   *  credential: another process may have saved a fresh sign-in since. */
  // An unreadable keychain is "nothing saved" here: the person is then asked in the browser, and a sign-in the
  // keychain will not keep is held in memory only (and revoked at close).
  const savedSignIn = (): Promise<string | null> =>
    store.load().catch((cause: unknown) => (cause instanceof KeychainUnavailableError ? null : Promise.reject(cause)));

  const forget = async (credential: Held): Promise<void> => {
    held = null;
    if (!credential.ephemeral && (await savedSignIn()) === credential.token) await store.clear();
  };

  type Redemption =
    | { kind: typeof RedemptionKind.enum.signed_in; held: Held }
    | { kind: typeof RedemptionKind.enum.pending }
    | { kind: typeof RedemptionKind.enum.gone };

  const redeemPending = async (): Promise<Redemption> => {
    if (pending === null) return { kind: RedemptionKind.enum.gone };
    const result = await run(() => redeemGrant(deps, pending!.deviceCode));
    if (result.isErr()) return { kind: RedemptionKind.enum.pending };
    if (result.value.kind === RedeemKind.enum.signed_in) {
      return { kind: RedemptionKind.enum.signed_in, held: await adopt(result.value) };
    }
    if (result.value.kind === RedeemKind.enum.pending) return { kind: RedemptionKind.enum.pending };
    pending = null;
    stopPolling();
    await closeTemporaryServer();
    return { kind: RedemptionKind.enum.gone };
  };

  const startPolling = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => void serially(redeemPending).catch(() => undefined), GRANT_POLL_INTERVAL_MS);
    timer.unref();
  };

  const clientInfo = (): ClientInfo => clientInfoOf(options.clientInfo());

  // A temporary server, once started, is the page its pending request was announced at, so it is named first.
  const linkOrigin = (): string | null => temporary?.origin ?? options.origin();

  /** The origin for a NEW request: one already nameable, else — when HTTP is on — a temporary server started now. */
  const originForNewRequest = async (): Promise<string | null> => {
    const named = linkOrigin();
    if (named !== null || options.temporaryServer === undefined) return named;
    temporary = await options.temporaryServer();
    return temporary.origin;
  };

  const instructions = async (): Promise<GateOutcome> => {
    const origin = linkOrigin();
    return notSignedIn(
      notSignedInMessage({
        origin,
        userCode: origin === null ? null : (pending?.userCode ?? null),
        ownerUnclaimed: await ownerNeedsSetup(deps),
      }),
    );
  };

  /** Not signed in: ask once and reuse the request until it is answered or runs out. */
  const askToSignIn = async (): Promise<GateOutcome> => {
    const redemption = await redeemPending();
    if (redemption.kind === RedemptionKind.enum.signed_in) return granted(redemption.held.principal);
    if (redemption.kind === RedemptionKind.enum.gone && (await originForNewRequest()) !== null) {
      // Whatever goes wrong creating the request — an Err or a throw — the page it would have served is closed again:
      // with no pending request there is no poll timer left to retire it.
      const started = await run(() =>
        startGrant(deps, { client: clientInfo(), profile: options.profile, channel: GrantChannel.enum.stdio }),
      ).then(
        (result) => result,
        async (cause: unknown) => {
          await closeTemporaryServer();
          throw cause;
        },
      );
      if (started.isErr()) {
        await closeTemporaryServer();
        return notSignedIn(STDIO_MESSAGES.cannotVerify);
      }
      pending = { deviceCode: started.value.deviceCode, userCode: started.value.userCode };
    }
    if (pending !== null) startPolling();
    return instructions();
  };

  const withEnvToken = async (token: string): Promise<GateOutcome> => {
    if (!isTokenShaped(token)) return notSignedIn(STDIO_MESSAGES.invalidEnvToken);
    const checked = await check(token);
    if (checked.kind === CheckKind.enum.failure) return notSignedIn(STDIO_MESSAGES.cannotVerify);
    return checked.kind === CheckKind.enum.ok
      ? granted(checked.principal)
      : notSignedIn(STDIO_MESSAGES.invalidEnvToken);
  };

  const withSavedSignIn = async (): Promise<GateOutcome> => {
    if (held !== null) {
      const checked = await check(held.token);
      if (checked.kind === CheckKind.enum.ok) {
        held = { ...held, principal: checked.principal };
        return granted(checked.principal);
      }
      if (checked.kind === CheckKind.enum.failure) return notSignedIn(STDIO_MESSAGES.cannotVerify);
      await forget(held);
    }
    const stored = await savedSignIn();
    if (stored !== null) {
      const checked = await check(stored);
      if (checked.kind === CheckKind.enum.failure) return notSignedIn(STDIO_MESSAGES.cannotVerify);
      if (checked.kind === CheckKind.enum.ok) {
        held = { token: stored, principal: checked.principal, ephemeral: false };
        return granted(checked.principal);
      }
      // A concurrent `login` may have replaced the entry while the database was asked: drop only the one found invalid.
      if ((await savedSignIn()) === stored) await store.clear();
    }
    return askToSignIn();
  };

  return {
    // An unexpected failure (the database is busy, the keychain misbehaves) is "could not check", never a
    // sign-out: nothing is forgotten or deleted on the strength of an error we did not understand.
    resolve: () =>
      serially(() => (options.envToken !== undefined ? withEnvToken(options.envToken) : withSavedSignIn())).catch(() =>
        notSignedIn(STDIO_MESSAGES.cannotVerify),
      ),

    close: () =>
      serially(async () => {
        stopPolling();
        await closeTemporaryServer();
        if (held === null || !held.ephemeral) return;
        const { token } = held;
        held = null;
        await run(() => revokeSignInByHash(deps, deps.secrets.hashSecret(token)));
      }).catch(() => undefined),
  };
};
