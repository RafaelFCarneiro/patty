import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../common/errors.js';
import { okOr } from '../common/result.js';
import {
  canLogin,
  evaluateToken,
  newAccessToken,
  revokedToken,
  summarizeToken,
  tokenDisplayPrefix,
  tokenPrincipal,
  usedToken,
} from '../logic/auth.js';
import * as persistence from '../logic/persistence.js';
import {
  ACCESS_TOKEN_ENTITY_TAG,
  authErrors,
  type AccessTokenSummary,
  type CreatedAccessToken,
  type CreateTokenInput,
  type Principal,
} from '../models/auth.js';
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
    yield* okOr(canLogin(user, passwordMatches) ? user : null, authErrors.invalidCredentials);

    const now = deps.clock();
    const token = deps.secrets.randomAccessToken();
    const entity = newAccessToken(
      { id: deps.newId(), userId, tokenHash: deps.secrets.hashSecret(token), prefix: tokenDisplayPrefix(token), input },
      now,
    );
    const persist: Persistable[] = [persistence.insert({ entity: ACCESS_TOKEN_ENTITY_TAG, model: entity })];
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
): ResultAsync<FlowOutcome<Principal | null>, AppError> =>
  safeTry(async function* () {
    const token = await deps.accessTokens.findByTokenHash(tokenHash);
    const user = token ? await deps.users.findById(token.userId) : null;
    const now = deps.clock();
    const verdict = evaluateToken(token, user, now);
    if (verdict.kind === 'invalid' || token === null || user === null) return ok({ persist: [], response: null });
    const persist: Persistable[] = verdict.touch
      ? [persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: usedToken(token, now) })]
      : [];
    return ok({ persist, response: tokenPrincipal(token, user) });
  });
