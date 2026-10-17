import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../common/errors.js';
import { okOr } from '../common/result.js';
import { canLogin } from '../logic/auth/password.js';
import {
  evaluateToken,
  newAccessToken,
  revokedToken,
  summarizeToken,
  tokenDisplayPrefix,
  tokenPrincipal,
  usedToken,
} from '../logic/auth/token.js';
import * as persistence from '../logic/persistence.js';
import { ACCESS_TOKEN_ENTITY_TAG, USER_ENTITY_TAG } from '../models/auth/entity.js';
import { authErrors } from '../models/auth/errors.js';
import { type Principal, PrincipalVia } from '../models/auth/principal.js';
import {
  AccessTokenKind,
  type AccessTokenSummary,
  type CreateTokenInput,
  type CreatedAccessToken,
} from '../models/auth/token.js';
import type { AuthDeps } from './deps.js';

/** Mint a personal access token for `userId` (ADR-033 §3) after re-checking their password (step-up: a script in
 *  the dashboard origin has the session cookie but not the password). The plaintext is in the response and nowhere
 *  else: only its sha256 and a display prefix are persisted. */
export const createToken = (
  deps: AuthDeps,
  userId: string,
  input: CreateTokenInput,
): ResultAsync<FlowOutcome<CreatedAccessToken>, AppError> =>
  safeTry(async function* () {
    const user = await deps.users.findById(userId);
    // Same cost whether or not the user has a password, like login.
    const passwordMatches = await deps.secrets.verifyPassword(
      user?.passwordHash ?? deps.secrets.dummyPasswordHash,
      input.password,
    );
    const account = yield* okOr(canLogin(user, passwordMatches) ? user : null, authErrors.invalidCredentials);

    const now = deps.clock();
    const token = deps.secrets.randomAccessToken();
    const entity = newAccessToken(
      { id: deps.newId(), userId, tokenHash: deps.secrets.hashSecret(token), prefix: tokenDisplayPrefix(token), input },
      now,
    );
    // The user row is re-written unchanged: a disable or reset racing this mint conflicts on its version and retries
    // into a refusal, so a credential can never be issued to a user after their credentials were ended.
    const persist: Persistable[] = [
      persistence.update({ entity: USER_ENTITY_TAG, model: account }),
      persistence.insert({ entity: ACCESS_TOKEN_ENTITY_TAG, model: entity }),
    ];
    return ok({ persist, response: { token, summary: summarizeToken(entity, now) } });
  });

/** Metadata only — never a hash. Newest first. */
export const listTokens = async (deps: AuthDeps, userId: string): Promise<AccessTokenSummary[]> => {
  const now = deps.clock();
  return R.map(await deps.accessTokens.listByUser(userId), (token) => summarizeToken(token, now));
};

/** Set `revoked_at` and keep the row. Idempotent: revoking an already-revoked token changes nothing. */
export const revokeToken = (deps: AuthDeps, userId: string, id: string): ResultAsync<FlowOutcome<void>, AppError> =>
  safeTry(async function* () {
    const token = yield* okOr(await deps.accessTokens.findById(userId, id), authErrors.unknownToken(id));
    const persist: Persistable[] =
      token.revokedAt === null
        ? [persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: revokedToken(token, deps.clock()) })]
        : [];
    return ok({ persist, response: undefined });
  });

/**
 * The auth hook's per-request question for a bearer token: whose is this, and with which scopes? Unknown,
 * revoked, expired, or belonging to an owner who is unclaimed or disabled → `null`. A valid token's
 * `last_used_at` is rewritten at most every `SESSION_TOUCH_INTERVAL_MS`, so the common request writes nothing.
 */
export const authenticateToken = (
  deps: AuthDeps,
  tokenHash: string,
  via: PrincipalVia = PrincipalVia.enum.token,
): ResultAsync<FlowOutcome<Principal | null>, AppError> =>
  safeTry(async function* () {
    const token = await deps.accessTokens.findByTokenHash(tokenHash);
    const user = token ? await deps.users.findById(token.userId) : null;
    const now = deps.clock();
    const verdict = evaluateToken(token, user, now, via);
    if (verdict.kind === 'invalid' || token === null || user === null) return ok({ persist: [], response: null });
    const persist: Persistable[] = verdict.touch
      ? [persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: usedToken(token, now) })]
      : [];
    return ok({ persist, response: tokenPrincipal(token, user, via) });
  });

/** Revoke a stdio sign-in by the credential itself — `fintrack logout` holds the token, not a session. Idempotent,
 *  and a no-op for anything but a stdio sign-in (a personal access token is revoked from the dashboard). */
export const revokeSignInByHash = (deps: AuthDeps, tokenHash: string): ResultAsync<FlowOutcome<boolean>, AppError> =>
  safeTry(async function* () {
    const found = await deps.accessTokens.findByTokenHash(tokenHash);
    const live = found?.kind === AccessTokenKind.enum.stdio && found.revokedAt === null ? found : null;
    return ok({
      persist: live
        ? [persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: revokedToken(live, deps.clock()) })]
        : [],
      response: live !== null,
    });
  });
