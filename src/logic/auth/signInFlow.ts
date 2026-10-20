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
import { Observed, CLOSE_PAGE, ObservationHandlers, ObservationHandler } from '../../models/auth/signInFlow.js';

const S = SignInStateKind.enum;
const O = ObservationKind.enum;
const E = EffectKind.enum;
const P = PresentationKind.enum;
const CHANNEL = GrantChannel.enum;

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

const withoutHeld = (state: SignInState): SignInState => {
  const pending = pendingOf(state);
  return pending === null ? IDLE : { kind: S.pending, pending };
};
const present = (presentation: Presentation): SignInEffect => ({ kind: E.present, presentation });
const step = (state: SignInState, ...effects: SignInEffect[]): SignInStep => ({ state, effects });
const tell = (state: SignInState, presentation: Presentation): SignInStep => step(state, present(presentation));
const ask = (state: SignInState, effect: SignInEffect): SignInStep => step(state, effect);

const ended = (kind: typeof S.denied | typeof S.expired | typeof S.cancelled | typeof S.failed, what: Presentation) =>
  step({ kind }, CLOSE_PAGE, present(what));

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
  tolerateUnreadable: purpose === LoadPurpose.enum.resolve,
});

const onRequested = (state: SignInState, config: SignInConfig): SignInStep => {
  if (config.envToken !== undefined) {
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

const showInstructions = (state: SignInState): SignInStep =>
  ask(state, { kind: E.name_page, purpose: PagePurpose.enum.instructions });

const askToSignIn = (state: SignInState): SignInStep => {
  const pending = pendingOf(state);
  return pending === null
    ? ask(state, { kind: E.name_page, purpose: PagePurpose.enum.new_request })
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

const withoutPage = (state: SignInState, purpose: PagePurpose): SignInStep =>
  purpose === PagePurpose.enum.login
    ? step({ kind: S.failed }, present(failedWith(STDIO_MESSAGES.notSignedInWithoutHttp)))
    : showInstructions(state);

const startRequestAt = (state: SignInState, origin: string, config: SignInConfig): SignInStep =>
  ask(state, { kind: E.start_grant, input: startInput(config), origin });

const onPageNamed = (state: SignInState, observation: Observed<typeof O.page_named>, config: SignInConfig) => {
  const { purpose, origin } = observation;
  if (purpose === PagePurpose.enum.instructions) {
    return ask(state, { kind: E.check_owner, purpose: OwnerPurpose.enum.instructions, origin });
  }
  if (origin !== null) return startRequestAt(state, origin, config);
  return observation.canServe ? ask(state, { kind: E.serve_page, purpose }) : withoutPage(state, purpose);
};

const onPageServed = (state: SignInState, observation: Observed<typeof O.page_served>, config: SignInConfig) =>
  observation.origin === null
    ? withoutPage(state, observation.purpose)
    : startRequestAt(state, observation.origin, config);

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
    ? step(state, CLOSE_PAGE, present({ kind: P.cannot_verify }))
    : ended(S.failed, failedWith(observation.error));

const onOwnerChecked = (state: SignInState, observation: Observed<typeof O.owner_checked>) => {
  if (observation.purpose === OwnerPurpose.enum.login) {
    return observation.unclaimed
      ? step({ kind: S.failed }, present({ kind: P.owner_unclaimed }))
      : ask(state, { kind: E.name_page, purpose: PagePurpose.enum.login });
  }
  const { origin } = observation;
  return tell(state, {
    kind: P.instructions,
    origin,
    userCode: origin === null ? null : (pendingOf(state)?.userCode ?? null),
    ownerUnclaimed: observation.unclaimed,
  });
};

const gone = (state: SignInState, then: Continuation): SignInStep => {
  const next = withoutPending(state);
  return then === Continuation.enum.ask
    ? step(next, CLOSE_PAGE, { kind: E.name_page, purpose: PagePurpose.enum.new_request })
    : step(next, CLOSE_PAGE);
};

const stillPending = (state: SignInState, config: SignInConfig, then: Continuation): SignInStep => {
  if (config.channel === CHANNEL.cli) return step(state, { kind: E.wait, ms: GRANT_POLL_INTERVAL_MS });
  return then === Continuation.enum.ask ? showInstructions(state) : step(state);
};

const adopted = (signedIn: SignedIn, ephemeral: boolean, then: Continuation, config: SignInConfig): SignInStep => {
  const held: HeldSignIn = { token: signedIn.token, principal: signedIn.principal, ephemeral };
  const next: SignInState = { kind: S.signed_in, held, pending: null };
  if (config.channel === CHANNEL.cli) {
    return step(
      next,
      CLOSE_PAGE,
      present({
        kind: P.signed_in,
        profile: config.profile,
        access: accessOf(signedIn),
        expiresAt: signedIn.expiresAt,
      }),
    );
  }
  return then === Continuation.enum.ask
    ? step(next, CLOSE_PAGE, present({ kind: P.granted, principal: signedIn.principal }))
    : step(next, CLOSE_PAGE);
};

const keepSignIn = (state: SignInState, signedIn: SignedIn, then: Continuation, config: SignInConfig): SignInStep =>
  persistsToKeychain(signedIn.duration)
    ? ask(state, { kind: E.save_credential, signedIn, then })
    : adopted(signedIn, true, then, config);

const onRedeemed = (state: SignInState, observation: Observed<typeof O.redeemed>, config: SignInConfig) => {
  const { result, then } = observation;
  switch (result.kind) {
    case RedeemKind.enum.signed_in:
      return keepSignIn(state, R.omit(result, ['kind']), then, config);
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
  return config.channel === CHANNEL.cli
    ? ask(state, { kind: E.revoke_credential, token: signedIn.token, reason: RevokeReason.enum.keychain_refused })
    : adopted(signedIn, true, then, config);
};

const onRevoked = (state: SignInState, observation: Observed<typeof O.revoked>) => {
  switch (observation.reason) {
    case RevokeReason.enum.keychain_refused:
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

const onClosed = (state: SignInState): SignInStep => {
  const base = withoutPending(state);
  if (base.kind === S.signed_in && base.held.ephemeral) {
    return step(IDLE, CLOSE_PAGE, {
      kind: E.revoke_credential,
      token: base.held.token,
      reason: RevokeReason.enum.close,
    });
  }
  return step(base, CLOSE_PAGE);
};

const OBSERVATION_HANDLERS = {
  [O.requested]: (state, _observation, config) => onRequested(state, config),
  [O.ticked]: onTicked,
  [O.login_requested]: (_state, _observation, config) => onLoginRequested(config),
  [O.logout_requested]: onLogoutRequested,
  [O.interrupted]: onInterrupted,
  [O.closed]: onClosed,
  [O.errored]: (state) => tell(state, { kind: P.cannot_verify }),
  [O.credential_checked]: onCredentialChecked,
  [O.saved_loaded]: onSavedLoaded,
  [O.saved_unreadable]: () => step({ kind: S.failed }, present({ kind: P.keychain_unreadable })),
  [O.saved_cleared]: onSavedCleared,
  [O.owner_checked]: onOwnerChecked,
  [O.page_named]: onPageNamed,
  [O.page_served]: onPageServed,
  [O.grant_started]: onGrantStarted,
  [O.grant_failed]: onGrantFailed,
  [O.redeemed]: onRedeemed,
  [O.saved]: onSaved,
  [O.revoked]: onRevoked,
} satisfies ObservationHandlers;

export const nextStep = (state: SignInState, observation: SignInObservation, config: SignInConfig): SignInStep =>
  (OBSERVATION_HANDLERS[observation.kind] as ObservationHandler)(state, observation, config);
