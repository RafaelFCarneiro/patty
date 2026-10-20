import { z } from 'zod';
import type { ClientInfo, GrantChannel, RedeemResult, SignedIn, SignInDuration, StartGrantInput } from './grant.js';
import type { Principal } from './principal.js';
import type { TokenAccess } from './token.js';

/**
 * The sign-in protocol, as data (ADR-034): where a stdio session or a `fintrack login` stands (`SignInState`), what it
 * has just learned (`SignInObservation`) and what the shell is asked to do about it (`SignInEffect`). The decisions are
 * `logic/auth/signInFlow.ts`'s `nextStep`; `src/composition/signIn/interpreter.ts` only executes effects and reports
 * what happened.
 */

export const SignInStateKind = z.enum(['idle', 'pending', 'signed_in', 'denied', 'expired', 'cancelled', 'failed']);
export type SignInStateKind = z.infer<typeof SignInStateKind>;

/** The request a person has been asked to approve. The device code is the asking process's secret. */
export type PendingSignIn = { deviceCode: string; userCode: string };

/** The credential this process acts with. An `ephemeral` one lives in memory only, revoked when the process ends. */
export type HeldSignIn = { token: string; principal: Principal; ephemeral: boolean };

export type SignInState =
  | { kind: typeof SignInStateKind.enum.idle }
  | { kind: typeof SignInStateKind.enum.pending; pending: PendingSignIn }
  /** `pending` stays while a request is still open behind a credential found elsewhere (the keychain). */
  | { kind: typeof SignInStateKind.enum.signed_in; held: HeldSignIn; pending: PendingSignIn | null }
  | {
      kind:
        | typeof SignInStateKind.enum.denied
        | typeof SignInStateKind.enum.expired
        | typeof SignInStateKind.enum.cancelled
        | typeof SignInStateKind.enum.failed;
    };

export const IDLE: SignInState = { kind: SignInStateKind.enum.idle };

/** What an attempt is made of: who is asking and how, fixed for the attempt. */
export type SignInConfig = {
  channel: GrantChannel;
  profile: string;
  client: ClientInfo;
  /** `false` under an explicit `FINTRACK_AUTH=disabled`: stdio acts as the owner, so there is nothing to sign in to. */
  authRequired: boolean;
  /** `FINTRACK_TOKEN`, when the stdio process has one. */
  envToken?: string | undefined;
  /** What `fintrack login --scope/--duration` would like pre-selected on the consent page. */
  hint?: { access?: TokenAccess | undefined; duration?: SignInDuration | undefined } | undefined;
};

/** Where a credential came from: the environment, this process's memory, or the keychain. */
export const CredentialSource = z.enum(['env', 'held', 'saved']);
export type CredentialSource = z.infer<typeof CredentialSource>;

/** What looking a credential up came to: usable, rejected, or "could not tell" (the lookup itself failed). */
export const CheckKind = z.enum(['ok', 'invalid', 'failure']);
export type CheckKind = z.infer<typeof CheckKind>;
export type CheckResult =
  | { kind: typeof CheckKind.enum.ok; principal: Principal }
  | { kind: typeof CheckKind.enum.invalid }
  | { kind: typeof CheckKind.enum.failure };

/** Redeeming a device code: what the controller answered, or the message of the error it failed with. */
export const REDEEM_ERROR_KIND = 'error';
export type RedeemOutcome = RedeemResult | { kind: typeof REDEEM_ERROR_KIND; error: string };

/** Who is waiting on an answer: a gated request (`ask`) or a poll tick (`poll`) — a poll never asks again. */
export const Continuation = z.enum(['ask', 'poll']);
export type Continuation = z.infer<typeof Continuation>;

/** What a keychain lookup was for, and what to do once a guarded clear has run. */
export const LoadPurpose = z.enum(['resolve', 'logout']);
export type LoadPurpose = z.infer<typeof LoadPurpose>;
export const ClearNext = z.enum(['load_saved', 'ask', 'signed_out']);
export type ClearNext = z.infer<typeof ClearNext>;

/** Why a page is opened, why the owner is looked at, and why a credential is revoked. */
export const PagePurpose = z.enum(['login', 'new_request', 'instructions']);
export type PagePurpose = z.infer<typeof PagePurpose>;
export const OwnerPurpose = z.enum(['login', 'instructions']);
export type OwnerPurpose = z.infer<typeof OwnerPurpose>;
export const RevokeReason = z.enum(['keychain_refused', 'logout', 'close']);
export type RevokeReason = z.infer<typeof RevokeReason>;

export const ObservationKind = z.enum([
  // Fed by an edge.
  'requested',
  'ticked',
  'login_requested',
  'logout_requested',
  'interrupted',
  'closed',
  'errored',
  // The answer to an asking effect.
  'credential_checked',
  'saved_loaded',
  'saved_unreadable',
  'saved_cleared',
  'owner_checked',
  'page_named',
  'page_served',
  'grant_started',
  'grant_failed',
  'redeemed',
  'saved',
  'revoked',
]);
export type ObservationKind = z.infer<typeof ObservationKind>;

export type SignInObservation =
  /** A gated stdio request wants to know who it acts as. */
  | { kind: typeof ObservationKind.enum.requested }
  /** The poll timer fired (stdio), or the login loop is due to look again. */
  | { kind: typeof ObservationKind.enum.ticked }
  | { kind: typeof ObservationKind.enum.login_requested }
  | { kind: typeof ObservationKind.enum.logout_requested }
  /** Ctrl-C at `fintrack login`. */
  | { kind: typeof ObservationKind.enum.interrupted }
  /** The stdio process is shutting down. */
  | { kind: typeof ObservationKind.enum.closed }
  /** Something unexpected threw while checking: not a sign-out, just "could not tell". */
  | { kind: typeof ObservationKind.enum.errored }
  | {
      kind: typeof ObservationKind.enum.credential_checked;
      source: CredentialSource;
      token: string;
      result: CheckResult;
    }
  | { kind: typeof ObservationKind.enum.saved_loaded; purpose: LoadPurpose; token: string | null }
  /** The keychain could not be read where the protocol said it must be (`tolerateUnreadable: false`). */
  | { kind: typeof ObservationKind.enum.saved_unreadable }
  | { kind: typeof ObservationKind.enum.saved_cleared; next: ClearNext }
  | {
      kind: typeof ObservationKind.enum.owner_checked;
      purpose: OwnerPurpose;
      unclaimed: boolean;
      origin: string | null;
    }
  /** What the process can name already (`null` for nothing), and whether it could serve a page of its own. */
  | { kind: typeof ObservationKind.enum.page_named; purpose: PagePurpose; origin: string | null; canServe: boolean }
  | { kind: typeof ObservationKind.enum.page_served; purpose: PagePurpose; origin: string | null }
  | { kind: typeof ObservationKind.enum.grant_started; deviceCode: string; userCode: string; origin: string }
  | { kind: typeof ObservationKind.enum.grant_failed; error: string }
  | { kind: typeof ObservationKind.enum.redeemed; then: Continuation; result: RedeemOutcome }
  | { kind: typeof ObservationKind.enum.saved; then: Continuation; signedIn: SignedIn; ok: boolean }
  | {
      kind: typeof ObservationKind.enum.revoked;
      reason: RevokeReason;
      token: string;
      ok: boolean;
      error: string | null;
    };

export const EffectKind = z.enum([
  // Asking: the shell reports one observation back.
  'check_credential',
  'load_saved',
  'clear_saved_if',
  'save_credential',
  'revoke_credential',
  'name_page',
  'serve_page',
  'start_grant',
  'redeem_grant',
  'check_owner',
  // Telling: nothing comes back.
  'close_page',
  'wait',
  'present',
]);
export type EffectKind = z.infer<typeof EffectKind>;

const E = EffectKind.enum;

/** The asking effects: a step ends with at most one of them, and it is the last. */
export const ASKING_EFFECT_KINDS: ReadonlySet<EffectKind> = new Set([
  E.check_credential,
  E.load_saved,
  E.clear_saved_if,
  E.save_credential,
  E.revoke_credential,
  E.name_page,
  E.serve_page,
  E.start_grant,
  E.redeem_grant,
  E.check_owner,
]);

export type SignInEffect =
  | { kind: typeof E.check_credential; source: CredentialSource; token: string }
  | { kind: typeof E.load_saved; purpose: LoadPurpose; tolerateUnreadable: boolean }
  /** Clear the saved sign-in only if it still holds `token`: another process may have replaced it meanwhile. */
  | { kind: typeof E.clear_saved_if; token: string; next: ClearNext; tolerateUnreadable: boolean }
  | { kind: typeof E.save_credential; signedIn: SignedIn; then: Continuation }
  | { kind: typeof E.revoke_credential; token: string; reason: RevokeReason }
  /** Which page the approver can be sent to: the origin this process can already name, if any. */
  | { kind: typeof E.name_page; purpose: PagePurpose }
  /** Start a temporary server of this process to serve it, when nothing names a page. */
  | { kind: typeof E.serve_page; purpose: PagePurpose }
  | { kind: typeof E.start_grant; input: StartGrantInput; origin: string }
  | { kind: typeof E.redeem_grant; deviceCode: string; then: Continuation }
  | { kind: typeof E.check_owner; purpose: OwnerPurpose; origin: string | null }
  | { kind: typeof E.close_page }
  | { kind: typeof E.wait; ms: number }
  | { kind: typeof E.present; presentation: Presentation };

export const PresentationKind = z.enum([
  // A stdio request's answer.
  'granted',
  'invalid_env_token',
  'cannot_verify',
  'instructions',
  // `fintrack login` / `logout`.
  'auth_disabled',
  'owner_unclaimed',
  'open',
  'waiting',
  'signed_in',
  'denied',
  'expired',
  'cancelled',
  'failed',
  'keychain_refused',
  'keychain_refused_still_active',
  'signed_out',
  'not_signed_in',
  'logout_failed',
  'keychain_unreadable',
]);
export type PresentationKind = z.infer<typeof PresentationKind>;

/** What an edge tells the person, as data: the edge owns the words (and the exit code), the protocol owns the facts. */
export type Presentation =
  | { kind: typeof PresentationKind.enum.granted; principal: Principal }
  | { kind: typeof PresentationKind.enum.invalid_env_token }
  | { kind: typeof PresentationKind.enum.cannot_verify }
  | {
      kind: typeof PresentationKind.enum.instructions;
      origin: string | null;
      userCode: string | null;
      ownerUnclaimed: boolean;
    }
  | { kind: typeof PresentationKind.enum.auth_disabled }
  | { kind: typeof PresentationKind.enum.owner_unclaimed }
  | { kind: typeof PresentationKind.enum.open; url: string; code: string }
  | { kind: typeof PresentationKind.enum.waiting }
  | { kind: typeof PresentationKind.enum.signed_in; profile: string; access: TokenAccess; expiresAt: string }
  | { kind: typeof PresentationKind.enum.denied }
  | { kind: typeof PresentationKind.enum.expired }
  | { kind: typeof PresentationKind.enum.cancelled }
  | { kind: typeof PresentationKind.enum.failed; reason: string }
  | { kind: typeof PresentationKind.enum.keychain_refused }
  | { kind: typeof PresentationKind.enum.keychain_refused_still_active }
  | { kind: typeof PresentationKind.enum.signed_out; profile: string }
  | { kind: typeof PresentationKind.enum.not_signed_in; profile: string }
  | { kind: typeof PresentationKind.enum.logout_failed; reason: string }
  | { kind: typeof PresentationKind.enum.keychain_unreadable };

/** What one observation does to the state, and what the shell must do about it, in order. */
export type SignInStep = { state: SignInState; effects: SignInEffect[] };

export type Observed<K extends ObservationKind> = Extract<SignInObservation, { kind: K }>;

export const CLOSE_PAGE: SignInEffect = { kind: E.close_page };

export type ObservationHandlers = {
  [K in ObservationKind]: (state: SignInState, observation: Observed<K>, config: SignInConfig) => SignInStep;
};

export type ObservationHandler = (
  state: SignInState,
  observation: SignInObservation,
  config: SignInConfig,
) => SignInStep;
