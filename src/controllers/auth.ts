import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import {
  canLogin,
  evaluateSession,
  formatSetupCode,
  isSetupCodeUsable,
  isUnclaimed,
  newSession,
  normalizeSetupCode,
  SETUP_CODE_TTL_MS,
  shouldIssueSetupCode,
  touched,
} from '../logic/auth.js';
import * as persistence from '../logic/persistence.js';
import {
  authErrors,
  OWNER_USER_ID,
  SESSION_ENTITY_TAG,
  SETUP_CODE_ENTITY_TAG,
  SETUP_CODE_ID,
  USER_ENTITY_TAG,
  type AuthMode,
  type ClaimOwnerInput,
  type IssuedSetupCode,
  type LoginInput,
  type Principal,
  type SessionEntity,
  type StartedSession,
} from '../models/auth.js';
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
    const owner = yield* okOr(await deps.users.findById(OWNER_USER_ID), authErrors.setupUnavailable);
    yield* guard(isUnclaimed(owner), authErrors.setupUnavailable);

    const now = deps.clock();
    const stored = await deps.setupCodes.findByHash(deps.secrets.hashSecret(normalizeSetupCode(input.code)));
    const code = yield* okOr(isSetupCodeUsable(stored, now) ? stored : null, authErrors.invalidSetupCode);

    const passwordHash = await deps.secrets.hashPassword(input.password);
    const { persistable: sessionInsert, started } = startSession(deps, owner.id, now);
    const persist: Persistable[] = [
      persistence.update({
        entity: USER_ENTITY_TAG,
        model: { ...owner, username: input.username, passwordHash },
      }),
      persistence.update({ entity: SETUP_CODE_ENTITY_TAG, model: { ...code, usedAt: now.toISOString() } }),
      sessionInsert,
    ];
    return ok({ persist, response: started });
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
    return ok({ persist, response: { userId: user.id, role: user.role } });
  });

/** Startup housekeeping: delete every session past its expiry. */
export const pruneExpiredSessions = (deps: AuthDeps): ResultAsync<FlowOutcome<number>, AppError> =>
  safeTry(async function* () {
    const expired = await deps.sessions.listExpired(deps.clock().toISOString());
    return ok({ persist: R.map(expired, removeSession), response: expired.length });
  });

/** Read-only: does the owner still need claiming? Drives the setup-vs-login redirect. */
export const ownerNeedsSetup = async (deps: AuthDeps): Promise<boolean> =>
  isUnclaimed(await deps.users.findById(OWNER_USER_ID));
