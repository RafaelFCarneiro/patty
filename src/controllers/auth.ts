import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import {
  claimedOwner,
  formatSetupCode,
  hasCredentials,
  isSetupCodeUsable,
  isUnclaimed,
  normalizeSetupCode,
  shouldIssueSetupCode,
  spentSetupCode,
} from '../logic/auth/owner.js';
import { canLogin, withPasswordHash } from '../logic/auth/password.js';
import { evaluateSession, newSession, sessionPrincipal, touched } from '../logic/auth/session.js';
import { isLiveToken, revokedToken } from '../logic/auth/token.js';
import * as persistence from '../logic/persistence.js';
import {
  ACCESS_TOKEN_ENTITY_TAG,
  SESSION_ENTITY_TAG,
  SETUP_CODE_ENTITY_TAG,
  USER_ENTITY_TAG,
} from '../models/auth/entity.js';
import { authErrors } from '../models/auth/errors.js';
import { type AuthMode } from '../models/auth/mode.js';
import {
  type ClaimedOwner,
  type ClaimedUserEntity,
  type IssuedSetupCode,
  OWNER_USER_ID,
  SETUP_CODE_ID,
  SETUP_CODE_TTL_MS,
  type UserEntity,
} from '../models/auth/owner.js';
import {
  type ClaimOwnerInput,
  type ClaimOwnerLocallyInput,
  type LoginInput,
  type PasswordReset,
  type ResetPasswordInput,
} from '../models/auth/password.js';
import { type Principal } from '../models/auth/principal.js';
import { type SessionEntity, type StartedSession } from '../models/auth/session.js';
import type { AuthDeps } from './deps.js';

const removeSession = (session: SessionEntity): Persistable =>
  persistence.remove({ entity: SESSION_ENTITY_TAG, id: session.id, version: session.version });

const startSession = (deps: AuthDeps, userId: string, now: Date) => {
  const token = deps.secrets.randomToken();
  const session = newSession({ id: deps.newId(), userId, tokenHash: deps.secrets.hashSecret(token) }, now);
  const persistable = persistence.insert({ entity: SESSION_ENTITY_TAG, model: session });
  const started: StartedSession = { token, expiresAt: session.expiresAt };
  return { persistable, started };
};

/** Startup: while auth is on and the owner has no credentials, mint a fresh one-time setup code, replacing the
 *  single setup-code row in place (a restart — or a concurrent starter — invalidates the previous code).
 *  Otherwise issue nothing. */
export const issueSetupCode = (
  deps: AuthDeps,
  mode: AuthMode,
): ResultAsync<FlowOutcome<IssuedSetupCode | null>, AppError> =>
  safeTry(async function* () {
    const owner = await deps.users.findById(OWNER_USER_ID);
    if (!shouldIssueSetupCode(mode, owner)) return ok({ persist: [], response: null });

    const now = deps.clock();
    const code = formatSetupCode(deps.secrets.randomSetupCode());
    const expiresAt = new Date(now.getTime() + SETUP_CODE_TTL_MS).toISOString();
    const fresh = {
      id: SETUP_CODE_ID,
      codeHash: deps.secrets.hashSecret(normalizeSetupCode(code)),
      createdAt: now.toISOString(),
      expiresAt,
      usedAt: null,
    };
    const current = await deps.setupCodes.current();
    const persist: Persistable[] = [
      current
        ? persistence.update({ entity: SETUP_CODE_ENTITY_TAG, model: { ...fresh, version: current.version } })
        : persistence.insert({ entity: SETUP_CODE_ENTITY_TAG, model: fresh }),
    ];
    return ok({ persist, response: { code, expiresAt } });
  });

const unclaimedOwner = (deps: AuthDeps): ResultAsync<UserEntity, AppError> =>
  safeTry(async function* () {
    const owner = yield* okOr(await deps.users.findById(OWNER_USER_ID), authErrors.setupUnavailable);
    yield* guard(isUnclaimed(owner), authErrors.setupUnavailable);
    return ok(owner);
  });

const claimOwnerUpdate = (owner: UserEntity, input: ClaimOwnerLocallyInput, passwordHash: string): Persistable =>
  persistence.update({
    entity: USER_ENTITY_TAG,
    model: claimedOwner(owner, { username: input.username, passwordHash }),
  });

/**
 * `/ui/setup`: the setup code claims the EXISTING owner row — sets its username and password — and
 * starts its first session. It emits an `update` of the owner and never an `insert` of any user, so
 * no path can create a second, empty user the data doesn't belong to (ADR-033 §2, §7).
 */
export const claimOwner = (
  deps: AuthDeps,
  input: ClaimOwnerInput,
): ResultAsync<FlowOutcome<StartedSession>, AppError> =>
  safeTry(async function* () {
    const owner = yield* unclaimedOwner(deps);

    const now = deps.clock();
    const stored = await deps.setupCodes.findByHash(deps.secrets.hashSecret(normalizeSetupCode(input.code)));
    const code = yield* okOr(isSetupCodeUsable(stored, now) ? stored : null, authErrors.invalidSetupCode);

    const passwordHash = await deps.secrets.hashPassword(input.password);
    const { persistable: sessionInsert, started } = startSession(deps, owner.id, now);
    const persist: Persistable[] = [
      claimOwnerUpdate(owner, input, passwordHash),
      persistence.update({ entity: SETUP_CODE_ENTITY_TAG, model: spentSetupCode(code, now) }),
      sessionInsert,
    ];
    return ok({ persist, response: started });
  });

/**
 * The CLI's owner claim: `claimOwner` without a setup code or a session. Reachable only by someone who can open the
 * database with its key, who already controls the data. An outstanding setup code is spent in the same batch.
 */
export const claimOwnerLocally = (
  deps: AuthDeps,
  input: ClaimOwnerLocallyInput,
): ResultAsync<FlowOutcome<ClaimedOwner>, AppError> =>
  safeTry(async function* () {
    const owner = yield* unclaimedOwner(deps);

    const now = deps.clock();
    const outstanding = await deps.setupCodes.current();
    const spent = outstanding !== null && outstanding.usedAt === null ? [spentSetupCode(outstanding, now)] : [];
    const persist: Persistable[] = [
      claimOwnerUpdate(owner, input, await deps.secrets.hashPassword(input.password)),
      ...spent.map((code) => persistence.update({ entity: SETUP_CODE_ENTITY_TAG, model: code })),
    ];
    return ok({ persist, response: { username: input.username } });
  });

export const findResetTarget = (
  deps: AuthDeps,
  username: string | undefined,
): ResultAsync<ClaimedUserEntity, AppError> =>
  safeTry(async function* () {
    if (username !== undefined) {
      const named = await deps.users.findByUsername(username);
      return ok(yield* okOr(named !== null && hasCredentials(named) ? named : null, authErrors.unknownUser(username)));
    }
    const owner = await deps.users.findById(OWNER_USER_ID);
    return ok(yield* okOr(owner !== null && hasCredentials(owner) ? owner : null, authErrors.ownerUnclaimed));
  });

/** CLI-only, like `claimOwnerLocally`: a new password, plus the end of that user's sessions and live tokens. */
export const resetPassword = (
  deps: AuthDeps,
  input: ResetPasswordInput,
): ResultAsync<FlowOutcome<PasswordReset>, AppError> =>
  safeTry(async function* () {
    const user = yield* findResetTarget(deps, input.username);

    const now = deps.clock();
    const sessions = await deps.sessions.listByUser(user.id);
    const liveTokens = R.filter(await deps.accessTokens.listByUser(user.id), isLiveToken(now));
    const persist: Persistable[] = [
      persistence.update({
        entity: USER_ENTITY_TAG,
        model: withPasswordHash(user, await deps.secrets.hashPassword(input.password)),
      }),
      ...R.map(sessions, removeSession),
      ...R.map(liveTokens, (token) =>
        persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: revokedToken(token, now) }),
      ),
    ];
    return ok({
      persist,
      response: {
        username: user.username,
        sessionsEnded: sessions.length,
        tokensRevoked: liveTokens.length,
      },
    });
  });

/** `/ui/login`: verifies against the real hash — or the dummy one for an unknown/unclaimed/disabled
 *  user, so every failure costs the same — and fails with one generic error. */
export const login = (deps: AuthDeps, input: LoginInput): ResultAsync<FlowOutcome<StartedSession>, AppError> =>
  safeTry(async function* () {
    const user = await deps.users.findByUsername(input.username);
    const passwordMatches = await deps.secrets.verifyPassword(
      user?.passwordHash ?? deps.secrets.dummyPasswordHash,
      input.password,
    );
    const account = yield* okOr(canLogin(user, passwordMatches) ? user : null, authErrors.invalidCredentials);

    const now = deps.clock();
    const { persistable: sessionInsert, started } = startSession(deps, account.id, now);
    const expired = R.map(await deps.sessions.listExpired(now.toISOString()), removeSession);
    return ok({ persist: [...expired, sessionInsert], response: started });
  });

/** Logout: delete the session row. Idempotent — an unknown or already-gone token is not an error. */
export const logout = (deps: AuthDeps, tokenHash: string): ResultAsync<FlowOutcome<void>, AppError> =>
  safeTry(async function* () {
    const session = await deps.sessions.findByTokenHash(tokenHash);
    return ok({ persist: session ? [removeSession(session)] : [], response: undefined });
  });

/**
 * The auth hook's per-request question: whose session is this? A valid one slides forward (throttled
 * to `SESSION_TOUCH_INTERVAL_MS` so the common request writes nothing); an expired one, or one whose
 * user can no longer log in, is deleted. `null` = unauthenticated.
 */
export const authenticate = (deps: AuthDeps, tokenHash: string): ResultAsync<FlowOutcome<Principal | null>, AppError> =>
  safeTry(async function* () {
    const session = await deps.sessions.findByTokenHash(tokenHash);
    if (!session) return ok({ persist: [], response: null });

    const user = await deps.users.findById(session.userId);
    const now = deps.clock();
    const verdict = evaluateSession(session, user, now);
    if (verdict.kind === 'invalid' || user === null) {
      return ok({ persist: [removeSession(session)], response: null });
    }
    const persist: Persistable[] = verdict.touch
      ? [persistence.update({ entity: SESSION_ENTITY_TAG, model: touched(session, now) })]
      : [];
    return ok({ persist, response: sessionPrincipal(user) });
  });

/** Startup housekeeping: delete every session past its expiry. */
export const pruneExpiredSessions = (deps: AuthDeps): ResultAsync<FlowOutcome<number>, AppError> =>
  safeTry(async function* () {
    const expired = await deps.sessions.listExpired(deps.clock().toISOString());
    return ok({ persist: R.map(expired, removeSession), response: expired.length });
  });

export const claimedOwnerOf = async (deps: AuthDeps): Promise<ClaimedOwner | null> => {
  const owner = await deps.users.findById(OWNER_USER_ID);
  return owner !== null && hasCredentials(owner) ? { username: owner.username } : null;
};

/** Read-only: does the owner still need claiming? Drives the setup-vs-login redirect. */
export const ownerNeedsSetup = async (deps: AuthDeps): Promise<boolean> =>
  isUnclaimed(await deps.users.findById(OWNER_USER_ID));
