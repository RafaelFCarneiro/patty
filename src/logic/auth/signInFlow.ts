import * as R from 'remeda';
import { GrantChannel, RedeemKind, type SignedIn } from '../../models/auth/grant.js';
import { STDIO_MESSAGES } from '../../models/auth/message.js';
import { WRITE_SCOPE } from '../../models/auth/scope.js';
import { GRANT_POLL_INTERVAL_MS } from '../../models/auth/signIn.js';
import {
  CheckKind,
  ClearNext,
  Continuation,
  CredentialSource,
  EffectKind,
  LoadPurpose,
  ObservationKind,
  OwnerPurpose,
  PagePurpose,
  PresentationKind,
  REDEEM_ERROR_KIND,
  RevokeReason,
  IDLE,
  SignInStateKind,
  type HeldSignIn,
  type PendingSignIn,
  type Presentation,
  type SignInConfig,
  type SignInEffect,
  type SignInObservation,
  type SignInState,
  type SignInStep,
} from '../../models/auth/signInFlow.js';
import { TokenAccess } from '../../models/auth/token.js';
import { persistsToKeychain } from './grant.js';
import { connectUrl } from './origin.js';
import { hasScope } from './scope.js';
import { isTokenShaped } from './token.js';

/**
 * The sign-in protocol (ADR-034), decided once for both of its edges — a stdio session that asks per gated request
 * and polls on a timer, and `fintrack login`, which loops until it ends. `nextStep(state, observation, config)` is a
 * pure function: it says what the new state is and which effects the shell must run, in order. A step ends with at
 * most one *asking* effect (`ASKING_EFFECT_KINDS`) and it is the last; the shell reports its answer back as the next
 * observation. Everything here that is a rule — an env token never falls back, an invalid saved credential is cleared
 * only if still the same, "this session only" never reaches the keychain, a refused save is revoked (cli) or kept in
 * memory (stdio), and a denied or expired request ends the attempt — lives in this file and nowhere else.
 */

const S = SignInStateKind.enum;
const O = ObservationKind.enum;
const E = EffectKind.enum;
const P = PresentationKind.enum;
const CHANNEL = GrantChannel.enum;

type Observed<K extends ObservationKind> = Extract<SignInObservation, { kind: K }>;

// ─── State helpers ──────────────────────────────────────────────────────────

export const pendingOf = (state: SignInState): PendingSignIn | null => {
  switch (state.kind) {
    case S.pending:
    case S.signed_in:
      return state.pending;
    default:
      return null;
  }
};

const withPending = (state: SignInState, pending: PendingSignIn): SignInState =>
  state.kind === S.signed_in ? { ...state, pending } : { kind: S.pending, pending };

const withoutPending = (state: SignInState): SignInState => {
  if (state.kind === S.pending) return IDLE;
  return state.kind === S.signed_in ? { ...state, pending: null } : state;
};

/** Once a credential is no longer good, only the request still open behind it (if any) remains. */
const withoutHeld = (state: SignInState): SignInState => {
  const pending = pendingOf(state);
  return pending === null ? IDLE : { kind: S.pending, pending };
};

// ─── Step helpers ───────────────────────────────────────────────────────────

const present = (presentation: Presentation): SignInEffect => ({ kind: E.present, presentation });
const step = (state: SignInState, ...effects: SignInEffect[]): SignInStep => ({ state, effects });
const tell = (state: SignInState, presentation: Presentation): SignInStep => step(state, present(presentation));
const ask = (state: SignInState, effect: SignInEffect): SignInStep => step(state, effect);

/** An attempt ends: the page it served is released first, then the person is told. */
const ended = (kind: typeof S.denied | typeof S.expired | typeof S.cancelled | typeof S.failed, what: Presentation) =>
  step({ kind }, { kind: E.close_page }, present(what));

const failedWith = (reason: string): Presentation => ({ kind: P.failed, reason });

const startInput = (config: SignInConfig) => ({
  client: config.client,
  profile: config.profile,
  channel: config.channel,
  ...(config.hint === undefined ? {} : { hint: config.hint }),
});

const accessOf = (signedIn: SignedIn): TokenAccess =>
  hasScope(signedIn.scopes, WRITE_SCOPE) ? TokenAccess.enum.write : TokenAccess.enum.read;

const loadSaved = (purpose: typeof LoadPurpose.enum.resolve | typeof LoadPurpose.enum.logout): SignInEffect => ({
  kind: E.load_saved,
  purpose,
  // An unreadable keychain is "nothing saved" to a session that can ask in the browser instead, but `logout` must
  // not claim a sign-out it could not check.
  tolerateUnreadable: purpose === LoadPurpose.enum.resolve,
});

// ─── A gated stdio request ──────────────────────────────────────────────────

const onRequested = (state: SignInState, config: SignInConfig): SignInStep => {
  if (config.envToken !== undefined) {
    // The environment's token is the only credential: no fallback to the keychain or to a new request, ever.
    return isTokenShaped(config.envToken)
      ? ask(state, { kind: E.check_credential, source: CredentialSource.enum.env, token: config.envToken })
      : tell(state, { kind: P.invalid_env_token });
  }
  return state.kind === S.signed_in
    ? ask(state, { kind: E.check_credential, source: CredentialSource.enum.held, token: state.held.token })
    : ask(state, loadSaved(LoadPurpose.enum.resolve));
};

const checkedEnv = (state: SignInState, result: Observed<typeof O.credential_checked>['result']): SignInStep => {
  if (result.kind === CheckKind.enum.ok) return tell(state, { kind: P.granted, principal: result.principal });
  return tell(state, { kind: result.kind === CheckKind.enum.invalid ? P.invalid_env_token : P.cannot_verify });
};

const checkedHeld = (state: SignInState, result: Observed<typeof O.credential_checked>['result']): SignInStep => {
  if (state.kind !== S.signed_in) return step(state);
  const { held } = state;
  switch (result.kind) {
    case CheckKind.enum.ok:
      return tell(
        { ...state, held: { ...held, principal: result.principal } },
        { kind: P.granted, principal: result.principal },
      );
    case CheckKind.enum.failure:
      return tell(state, { kind: P.cannot_verify });
    case CheckKind.enum.invalid: {
      // Forget it. A saved one goes from the keychain too — but only if the keychain still holds this very credential.
      const dropped = withoutHeld(state);
      return held.ephemeral
        ? ask(dropped, loadSaved(LoadPurpose.enum.resolve))
        : ask(dropped, {
            kind: E.clear_saved_if,
            token: held.token,
            next: ClearNext.enum.load_saved,
            tolerateUnreadable: true,
          });
    }
  }
};

const checkedSaved = (
  state: SignInState,
  token: string,
  result: Observed<typeof O.credential_checked>['result'],
): SignInStep => {
  switch (result.kind) {
    case CheckKind.enum.ok:
      return tell(
        {
          kind: S.signed_in,
          held: { token, principal: result.principal, ephemeral: false },
          pending: pendingOf(state),
        },
        { kind: P.granted, principal: result.principal },
      );
    case CheckKind.enum.failure:
      return tell(state, { kind: P.cannot_verify });
    case CheckKind.enum.invalid:
      // A concurrent `login` may have replaced the entry while the database was asked: drop only the one found invalid.
      return ask(state, {
        kind: E.clear_saved_if,
        token,
        next: ClearNext.enum.ask,
        tolerateUnreadable: true,
      });
  }
};

const onCredentialChecked = (state: SignInState, observation: Observed<typeof O.credential_checked>): SignInStep => {
  switch (observation.source) {
    case CredentialSource.enum.env:
      return checkedEnv(state, observation.result);
    case CredentialSource.enum.held:
      return checkedHeld(state, observation.result);
    case CredentialSource.enum.saved:
      return checkedSaved(state, observation.token, observation.result);
  }
};

// ─── Not signed in: ask once, reuse the request until it is answered or runs out ───────

/** The page to name, or none at all when no HTTP server is involved. Always read right before it is shown. */
const showInstructions = (state: SignInState): SignInStep => ask(state, { kind: E.name_page });

const askToSignIn = (state: SignInState): SignInStep => {
  const pending = pendingOf(state);
  return pending === null
    ? ask(state, { kind: E.open_page, purpose: PagePurpose.enum.new_request })
    : ask(state, { kind: E.redeem_grant, deviceCode: pending.deviceCode, then: Continuation.enum.ask });
};

const onSavedLoaded = (state: SignInState, observation: Observed<typeof O.saved_loaded>, config: SignInConfig) => {
  if (observation.purpose === LoadPurpose.enum.logout) {
    return observation.token === null
      ? tell(state, { kind: P.not_signed_in, profile: config.profile })
      : ask(state, { kind: E.revoke_credential, token: observation.token, reason: RevokeReason.enum.logout });
  }
  return observation.token === null
    ? askToSignIn(state)
    : ask(state, { kind: E.check_credential, source: CredentialSource.enum.saved, token: observation.token });
};

const onSavedCleared = (state: SignInState, observation: Observed<typeof O.saved_cleared>, config: SignInConfig) => {
  switch (observation.next) {
    case ClearNext.enum.load_saved:
      return ask(state, loadSaved(LoadPurpose.enum.resolve));
    case ClearNext.enum.ask:
      return askToSignIn(state);
    case ClearNext.enum.signed_out:
      return tell(state, { kind: P.signed_out, profile: config.profile });
  }
};

const onPageOpened = (state: SignInState, observation: Observed<typeof O.page_opened>, config: SignInConfig) => {
  const { origin } = observation;
  if (origin !== null) return ask(state, { kind: E.start_grant, input: startInput(config), origin });
  // No page to approve on: `login` cannot go on at all; a stdio session says how else to sign in.
  return observation.purpose === PagePurpose.enum.login
    ? step({ kind: S.failed }, present(failedWith(STDIO_MESSAGES.notSignedInWithoutHttp)))
    : showInstructions(state);
};

const onGrantStarted = (state: SignInState, observation: Observed<typeof O.grant_started>, config: SignInConfig) => {
  const next = withPending(state, { deviceCode: observation.deviceCode, userCode: observation.userCode });
  if (config.channel === CHANNEL.stdio) return showInstructions(next);
  return step(
    next,
    present({
      kind: P.open,
      url: connectUrl(observation.origin, observation.userCode),
      code: observation.userCode,
    }),
    present({ kind: P.waiting }),
  );
};

const onGrantFailed = (state: SignInState, observation: Observed<typeof O.grant_failed>, config: SignInConfig) =>
  config.channel === CHANNEL.stdio
    ? step(state, { kind: E.close_page }, present({ kind: P.cannot_verify }))
    : ended(S.failed, failedWith(observation.error));

const onPageNamed = (state: SignInState, observation: Observed<typeof O.page_named>) =>
  ask(state, { kind: E.check_owner, purpose: OwnerPurpose.enum.instructions, origin: observation.origin });

const onOwnerChecked = (state: SignInState, observation: Observed<typeof O.owner_checked>) => {
  if (observation.purpose === OwnerPurpose.enum.login) {
    return observation.unclaimed
      ? step({ kind: S.failed }, present({ kind: P.owner_unclaimed }))
      : ask(state, { kind: E.open_page, purpose: PagePurpose.enum.login });
  }
  const { origin } = observation;
  return tell(state, {
    kind: P.instructions,
    origin,
    userCode: origin === null ? null : (pendingOf(state)?.userCode ?? null),
    ownerUnclaimed: observation.unclaimed,
  });
};

// ─── A request's answer ─────────────────────────────────────────────────────

/** The request is spent (answered or out of time): a stdio session is back to asking, `login` has its outcome. */
const gone = (state: SignInState, then: Continuation): SignInStep => {
  const next = withoutPending(state);
  const release: SignInEffect = { kind: E.close_page };
  return then === Continuation.enum.ask
    ? step(next, release, { kind: E.open_page, purpose: PagePurpose.enum.new_request })
    : step(next, release);
};

/** Still waiting for a person (or the lookup failed, which a stdio session treats the same). */
const stillPending = (state: SignInState, config: SignInConfig, then: Continuation): SignInStep => {
  if (config.channel === CHANNEL.cli) return step(state, { kind: E.wait, ms: GRANT_POLL_INTERVAL_MS });
  return then === Continuation.enum.ask ? showInstructions(state) : step(state);
};

/** The credential is in hand: kept in the keychain, or in memory only when it must (or the keychain won't have it). */
const adopted = (signedIn: SignedIn, ephemeral: boolean, then: Continuation, config: SignInConfig): SignInStep => {
  const held: HeldSignIn = { token: signedIn.token, principal: signedIn.principal, ephemeral };
  const next: SignInState = { kind: S.signed_in, held, pending: null };
  const release: SignInEffect = { kind: E.close_page };
  if (config.channel === CHANNEL.cli) {
    return step(
      next,
      release,
      present({
        kind: P.signed_in,
        profile: config.profile,
        access: accessOf(signedIn),
        expiresAt: signedIn.expiresAt,
      }),
    );
  }
  return then === Continuation.enum.ask
    ? step(next, release, present({ kind: P.granted, principal: signedIn.principal }))
    : step(next, release);
};

const onRedeemed = (state: SignInState, observation: Observed<typeof O.redeemed>, config: SignInConfig) => {
  const { result, then } = observation;
  switch (result.kind) {
    case RedeemKind.enum.signed_in: {
      const signedIn: SignedIn = R.omit(result, ['kind']);
      // "This session only" never reaches the keychain.
      return persistsToKeychain(signedIn.duration)
        ? ask(state, { kind: E.save_credential, signedIn, then })
        : adopted(signedIn, true, then, config);
    }
    case REDEEM_ERROR_KIND:
      return config.channel === CHANNEL.cli
        ? ended(S.failed, failedWith(result.error))
        : stillPending(state, config, then);
    case RedeemKind.enum.pending:
      return stillPending(state, config, then);
    case RedeemKind.enum.denied:
      return config.channel === CHANNEL.cli ? ended(S.denied, { kind: P.denied }) : gone(state, then);
    case RedeemKind.enum.expired:
    case RedeemKind.enum.invalid:
      return config.channel === CHANNEL.cli ? ended(S.expired, { kind: P.expired }) : gone(state, then);
  }
};

const onSaved = (state: SignInState, observation: Observed<typeof O.saved>, config: SignInConfig) => {
  const { signedIn, then } = observation;
  if (observation.ok) return adopted(signedIn, false, then, config);
  // A sign-in nothing can find again is just a live secret: `login` takes it back, a stdio session keeps it in memory
  // and revokes it at close.
  return config.channel === CHANNEL.cli
    ? ask(state, { kind: E.revoke_credential, token: signedIn.token, reason: RevokeReason.enum.keychain_refused })
    : adopted(signedIn, true, then, config);
};

const onRevoked = (state: SignInState, observation: Observed<typeof O.revoked>) => {
  switch (observation.reason) {
    case RevokeReason.enum.keychain_refused:
      // Never claim a cleanup that did not commit: an unrevoked credential nothing references is the one to flag.
      return ended(S.failed, { kind: observation.ok ? P.keychain_refused : P.keychain_refused_still_active });
    case RevokeReason.enum.logout:
      return observation.ok
        ? ask(state, {
            kind: E.clear_saved_if,
            token: observation.token,
            next: ClearNext.enum.signed_out,
            tolerateUnreadable: false,
          })
        : step({ kind: S.failed }, present({ kind: P.logout_failed, reason: observation.error ?? '' }));
    case RevokeReason.enum.close:
      return step(state);
  }
};

// ─── Edge-fed observations ──────────────────────────────────────────────────

const onTicked = (state: SignInState): SignInStep => {
  const pending = pendingOf(state);
  return pending === null
    ? step(state)
    : ask(state, { kind: E.redeem_grant, deviceCode: pending.deviceCode, then: Continuation.enum.poll });
};

const onLoginRequested = (config: SignInConfig): SignInStep =>
  config.authRequired
    ? ask(IDLE, { kind: E.check_owner, purpose: OwnerPurpose.enum.login, origin: null })
    : step({ kind: S.failed }, present({ kind: P.auth_disabled }));

const onLogoutRequested = (): SignInStep => ask(IDLE, loadSaved(LoadPurpose.enum.logout));

const onInterrupted = (state: SignInState): SignInStep =>
  state.kind === S.pending ? ended(S.cancelled, { kind: P.cancelled }) : step(state);

/** Shutdown: stop asking, release the page, and take back a credential that lives in memory only. */
const onClosed = (state: SignInState): SignInStep => {
  const base = withoutPending(state);
  const release: SignInEffect = { kind: E.close_page };
  if (base.kind === S.signed_in && base.held.ephemeral) {
    return step(IDLE, release, { kind: E.revoke_credential, token: base.held.token, reason: RevokeReason.enum.close });
  }
  return step(base, release);
};

/** What happens next, given what was just seen. Total: an observation the state has no use for changes nothing. */
export const nextStep = (state: SignInState, observation: SignInObservation, config: SignInConfig): SignInStep => {
  switch (observation.kind) {
    case O.requested:
      return onRequested(state, config);
    case O.ticked:
      return onTicked(state);
    case O.login_requested:
      return onLoginRequested(config);
    case O.logout_requested:
      return onLogoutRequested();
    case O.interrupted:
      return onInterrupted(state);
    case O.closed:
      return onClosed(state);
    case O.errored:
      // An unexpected failure (the database is busy, the keychain misbehaves) is "could not check", never a sign-out:
      // nothing is forgotten or deleted on the strength of an error we did not understand.
      return tell(state, { kind: P.cannot_verify });
    case O.credential_checked:
      return onCredentialChecked(state, observation);
    case O.saved_loaded:
      return onSavedLoaded(state, observation, config);
    case O.saved_cleared:
      return onSavedCleared(state, observation, config);
    case O.owner_checked:
      return onOwnerChecked(state, observation);
    case O.page_named:
      return onPageNamed(state, observation);
    case O.page_opened:
      return onPageOpened(state, observation, config);
    case O.grant_started:
      return onGrantStarted(state, observation, config);
    case O.grant_failed:
      return onGrantFailed(state, observation, config);
    case O.redeemed:
      return onRedeemed(state, observation, config);
    case O.saved:
      return onSaved(state, observation, config);
    case O.revoked:
      return onRevoked(state, observation);
  }
};
