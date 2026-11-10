import { validation } from '../error.js';
import { AUTH_MESSAGES } from './message.js';
import type { Scope } from './scope.js';

export type AuthError =
  | { code: 'unauthenticated' }
  | { code: 'invalid_credentials' }
  | { code: 'invalid_setup_code' }
  | { code: 'setup_unavailable' }
  | { code: 'unknown_user'; username: string }
  | { code: 'owner_unclaimed' }
  | { code: 'rate_limited' }
  | { code: 'forbidden_origin'; hint: string }
  | { code: 'invalid_token' }
  | { code: 'insufficient_scope'; scope: Scope }
  | { code: 'unknown_token'; id: string }
  | { code: 'session_required' }
  | { code: 'invalid_grant' }
  | { code: 'admin_required' }
  | { code: 'username_taken'; username: string }
  | { code: 'cannot_change_self' }
  | { code: 'last_admin' }
  | { code: 'invalid_invite' }
  | { code: 'user_disabled' }
  | { code: 'resource_metadata_unavailable'; hint: string };

export const authErrors = {
  unauthenticated: { code: 'unauthenticated' } satisfies AuthError,
  // One message for unknown user, wrong password, unclaimed owner and disabled user alike — the
  // response must not say which (ADR-033 §2).
  invalidCredentials: { code: 'invalid_credentials' } satisfies AuthError,
  // Wrong, expired and already-used codes are indistinguishable by design.
  invalidSetupCode: { code: 'invalid_setup_code' } satisfies AuthError,
  setupUnavailable: { code: 'setup_unavailable' } satisfies AuthError,
  unknownUser: (username: string): AuthError => ({ code: 'unknown_user', username }),
  ownerUnclaimed: { code: 'owner_unclaimed' } satisfies AuthError,
  rateLimited: { code: 'rate_limited' } satisfies AuthError,
  // CSRF (ADR-033 §2): a cookie-authenticated unsafe request whose Origin is not ours.
  crossOrigin: { code: 'forbidden_origin', hint: AUTH_MESSAGES.crossOrigin } satisfies AuthError,
  // Auth disabled: only a loopback Host (and Origin, if any) is answered — the DNS-rebinding / cross-site guard.
  nonLoopbackRequest: { code: 'forbidden_origin', hint: AUTH_MESSAGES.nonLoopbackRequest } satisfies AuthError,
  unknownOrigin: { code: 'forbidden_origin', hint: AUTH_MESSAGES.crossOriginUnknownOrigin } satisfies AuthError,
  // Bearer credential present but unusable: malformed, unknown, revoked, expired, or its owner can't log in.
  invalidToken: { code: 'invalid_token' } satisfies AuthError,
  insufficientScope: (scope: Scope) => ({ code: 'insufficient_scope', scope }) as const satisfies AuthError,
  // Token management is for a person at a browser, never for a bearer token.
  sessionRequired: { code: 'session_required' } satisfies AuthError,
  unknownToken: (id: string): AuthError => ({ code: 'unknown_token', id }),
  // A `patty login` request has no "session" to tie a sign-in to.
  sessionDurationRefused: validation(['a sign-in requested by `patty login` cannot last "this session only"']),
  // Unknown, expired, denied, already-approved or already-redeemed: indistinguishable, like a setup code.
  invalidGrant: { code: 'invalid_grant' } satisfies AuthError,
  // User management is for signed-in admins; to anyone else it reads as a page that does not exist.
  adminRequired: { code: 'admin_required' } satisfies AuthError,
  usernameTaken: (username: string): AuthError => ({ code: 'username_taken', username }),
  cannotChangeSelf: { code: 'cannot_change_self' } satisfies AuthError,
  lastAdmin: { code: 'last_admin' } satisfies AuthError,
  // Wrong, expired, used, revoked and foreign invites are indistinguishable by design, like a setup code.
  invalidInvite: { code: 'invalid_invite' } satisfies AuthError,
  userDisabled: { code: 'user_disabled' } satisfies AuthError,
  // No PUBLIC_URL and a non-loopback Host: the instance cannot name the resource it would describe.
  metadataUnavailable: {
    code: 'resource_metadata_unavailable',
    hint: AUTH_MESSAGES.prmNeedsOrigin,
  } satisfies AuthError,
};

export type ChallengeableError = Extract<
  AuthError,
  { code: 'unauthenticated' | 'invalid_token' | 'insufficient_scope' }
>;
