import { z } from 'zod';
import { authenticateToken, revokeSignInByHash } from '../../controllers/accessTokens.js';
import type { AuthDeps, RunEffects, SignInStore } from '../../controllers/deps.js';
import { ownerNeedsSetup } from '../../controllers/auth.js';
import { redeemGrant, startGrant } from '../../controllers/grants.js';
import { isTokenShaped, notSignedInMessage, persistsToKeychain } from '../../logic/auth.js';
import {
  GRANT_POLL_INTERVAL_MS,
  GrantChannel,
  PrincipalVia,
  RedeemKind,
  STDIO_MESSAGES,
  type ClientInfo,
  type Principal,
  type SignedIn,
} from '../../models/auth.js';
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
  /** The origin serving `/ui/connect`, or `null` when there is no HTTP server (`FINTRACK_HTTP=false`). Asked at
   *  use, because the sidecar binds after the session exists. */
  origin: () => string | null;
  /** What the MCP client reported in `initialize` (`undefined` before it has). */
  clientInfo: () => unknown;
};

type Held = {
  token: string;
  scopes: readonly string[];
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

const granted = (scopes: readonly string[]): GateOutcome => ({ kind: GateKind.enum.granted, scopes });
const notSignedIn = (message: string): GateOutcome => ({ kind: GateKind.enum.not_signed_in, message });

export const createStdioSession = (options: StdioSessionOptions): StdioSession => {
  const { deps, run, store } = options;
  let held: Held | null = null;
  let pending: Pending | null = null;
  let timer: NodeJS.Timeout | null = null;

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

  const adopt = async (signedIn: SignedIn): Promise<Held> => {
    // A sign-in the keychain would not keep lives in memory alone, so like "this session only" it is revoked at close.
    const ephemeral = !persistsToKeychain(signedIn.duration) || !(await store.save(signedIn.token));
    held = { token: signedIn.token, scopes: signedIn.scopes, ephemeral };
    pending = null;
    stopPolling();
    return held;
  };

  /** Drop a credential that turned out unusable. The keychain entry goes too — but only if it still holds this very
   *  credential: another process may have saved a fresh sign-in since. */
  const forget = async (credential: Held): Promise<void> => {
    held = null;
    if (!credential.ephemeral && (await store.load()) === credential.token) await store.clear();
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
    return { kind: RedemptionKind.enum.gone };
  };

  const startPolling = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => void serially(redeemPending).catch(() => undefined), GRANT_POLL_INTERVAL_MS);
    timer.unref();
  };

  const clientInfo = (): ClientInfo => clientInfoOf(options.clientInfo());

  const instructions = async (): Promise<GateOutcome> => {
    const origin = options.origin();
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
    if (redemption.kind === RedemptionKind.enum.signed_in) return granted(redemption.held.scopes);
    if (redemption.kind === RedemptionKind.enum.gone && options.origin() !== null) {
      const started = await run(() =>
        startGrant(deps, { client: clientInfo(), profile: options.profile, channel: GrantChannel.enum.stdio }),
      );
      if (started.isErr()) return notSignedIn(STDIO_MESSAGES.cannotVerify);
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
      ? granted(checked.principal.scopes)
      : notSignedIn(STDIO_MESSAGES.invalidEnvToken);
  };

  const withSavedSignIn = async (): Promise<GateOutcome> => {
    if (held !== null) {
      const checked = await check(held.token);
      if (checked.kind === CheckKind.enum.ok) return granted(checked.principal.scopes);
      if (checked.kind === CheckKind.enum.failure) return notSignedIn(STDIO_MESSAGES.cannotVerify);
      await forget(held);
    }
    const stored = await store.load();
    if (stored !== null) {
      const checked = await check(stored);
      if (checked.kind === CheckKind.enum.failure) return notSignedIn(STDIO_MESSAGES.cannotVerify);
      if (checked.kind === CheckKind.enum.ok) {
        held = { token: stored, scopes: checked.principal.scopes, ephemeral: false };
        return granted(checked.principal.scopes);
      }
      // A concurrent `login` may have replaced the entry while the database was asked: drop only the one found invalid.
      if ((await store.load()) === stored) await store.clear();
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
        if (held === null || !held.ephemeral) return;
        const { token } = held;
        held = null;
        await run(() => revokeSignInByHash(deps, deps.secrets.hashSecret(token)));
      }).catch(() => undefined),
  };
};
