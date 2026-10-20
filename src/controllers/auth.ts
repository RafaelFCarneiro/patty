import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import {
  claimedOwner,
  claimRaceWinner,
  formatSetupCode,
  hasCredentials,
  isActiveUser,
  isNeverClaimed,
  isSetupCodeUsable,
  isUnclaimed,
  normalizeSetupCode,
  planOwnerClaim,
  shouldIssueSetupCode,
  spentSetupCode,
} from '../logic/auth/owner.js';
import { canLogin, withPasswordHash } from '../logic/auth/password.js';
import { evaluateSession, newSession, sessionPrincipal, touched } from '../logic/auth/session.js';
import { endingCredentials, removeSession } from '../logic/auth/revoke.js';
import { loggedIn, withCredentialsChanged } from '../logic/auth/users.js';
import * as persistence from '../logic/persistence.js';
import { SESSION_ENTITY_TAG, SETUP_CODE_ENTITY_TAG, USER_ENTITY_TAG } from '../models/auth/entity.js';
import { authErrors } from '../models/auth/errors.js';
import type { AuthMode } from '../models/auth/mode.js';
import {
  type ClaimedOwner,
  type ClaimedUserEntity,
  type ClaimPlan,
  type IssuedSetupCode,
  OWNER_USER_ID,
  SETUP_CODE_ID,
  SETUP_CODE_TTL_MS,
  type UserEntity,
} from '../models/auth/owner.js';
import type {
  ClaimOwnerInput,
  ClaimOwnerLocallyInput,
  LoginInput,
  PasswordReset,
  ResetPasswordInput,
} from '../models/auth/password.js';
import type { Principal } from '../models/auth/principal.js';
import type { StartedSession } from '../models/auth/session.js';
import type { AuthDeps } from './deps.js';

export const startSession = (deps: AuthDeps, userId: string, now: Date) => {
  const token = deps.secrets.randomToken();
  const session = newSession({ id: deps.newId(), userId, tokenHash: deps.secrets.hashSecret(token) }, now);
  const persistable = persistence.insert({ entity: SESSION_ENTITY_TAG, model: session });
  const started: StartedSession = { token, expiresAt: session.expiresAt };
  return { persistable, started };
};

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

const nameAvailableTo = async (deps: AuthDeps, owner: UserEntity, username: string) => {
  const holder = await deps.users.findByUsername(username);
  return guard(holder === null || holder.id === owner.id, authErrors.usernameTaken(username));
};

const claimOwnerUpdate = (
  owner: UserEntity,
  input: ClaimOwnerLocallyInput,
  passwordHash: string,
  now: Date,
): Persistable =>
  persistence.update({
    entity: USER_ENTITY_TAG,
    model: withCredentialsChanged(claimedOwner(owner, { username: input.username, passwordHash }), now),
  });

export const claimOwner = (
  deps: AuthDeps,
  input: ClaimOwnerInput,
): ResultAsync<FlowOutcome<StartedSession>, AppError> =>
  safeTry(async function* () {
    const owner = yield* unclaimedOwner(deps);
    yield* guard(isNeverClaimed(owner), authErrors.setupUnavailable);

    const now = deps.clock();
    const stored = await deps.setupCodes.findByHash(deps.secrets.hashSecret(normalizeSetupCode(input.code)));
    const code = yield* okOr(isSetupCodeUsable(stored, now) ? stored : null, authErrors.invalidSetupCode);
    yield* await nameAvailableTo(deps, owner, input.username);

    const passwordHash = await deps.secrets.hashPassword(input.password);
    const { persistable: sessionInsert, started } = startSession(deps, owner.id, now);
    const persist: Persistable[] = [
      claimOwnerUpdate(loggedIn(owner, now), input, passwordHash, now),
      persistence.update({ entity: SETUP_CODE_ENTITY_TAG, model: spentSetupCode(code, now) }),
      sessionInsert,
    ];
    return ok({ persist, response: started });
  });

export const claimOwnerLocally = (
  deps: AuthDeps,
  input: ClaimOwnerLocallyInput,
): ResultAsync<FlowOutcome<ClaimedOwner>, AppError> =>
  safeTry(async function* () {
    const owner = yield* unclaimedOwner(deps);
    yield* await nameAvailableTo(deps, owner, input.username);

    const now = deps.clock();
    const outstanding = await deps.setupCodes.current();
    const spent = outstanding !== null && outstanding.usedAt === null ? [spentSetupCode(outstanding, now)] : [];
    const persist: Persistable[] = [
      claimOwnerUpdate(owner, input, await deps.secrets.hashPassword(input.password), now),
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

export const resetPassword = (
  deps: AuthDeps,
  input: ResetPasswordInput,
): ResultAsync<FlowOutcome<PasswordReset>, AppError> =>
  safeTry(async function* () {
    const user = yield* findResetTarget(deps, input.username);

    const now = deps.clock();
    const ended = endingCredentials(
      {
        sessions: await deps.sessions.listByUser(user.id),
        tokens: await deps.accessTokens.listByUser(user.id),
        approvedGrants: await deps.clientGrants.listApprovedByUser(user.id),
      },
      now,
    );
    const persist: Persistable[] = [
      persistence.update({
        entity: USER_ENTITY_TAG,
        model: withCredentialsChanged(withPasswordHash(user, await deps.secrets.hashPassword(input.password)), now),
      }),
      ...ended.persist,
    ];
    return ok({ persist, response: { username: user.username, ...ended.revoked } });
  });

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
    const seen = persistence.update({ entity: USER_ENTITY_TAG, model: loggedIn(account, now) });
    return ok({ persist: [...expired, seen, sessionInsert], response: started });
  });

export const logout = (deps: AuthDeps, tokenHash: string): ResultAsync<FlowOutcome<void>, AppError> =>
  safeTry(async function* () {
    const session = await deps.sessions.findByTokenHash(tokenHash);
    return ok({ persist: session ? [removeSession(session)] : [], response: undefined });
  });

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
    return ok({ persist, response: sessionPrincipal(user, session) });
  });

export const pruneExpiredSessions = (deps: AuthDeps): ResultAsync<FlowOutcome<number>, AppError> =>
  safeTry(async function* () {
    const expired = await deps.sessions.listExpired(deps.clock().toISOString());
    return ok({ persist: R.map(expired, removeSession), response: expired.length });
  });

export const claimedOwnerOf = async (deps: AuthDeps): Promise<ClaimedOwner | null> => {
  const owner = await deps.users.findById(OWNER_USER_ID);
  return owner !== null && hasCredentials(owner) ? { username: owner.username } : null;
};

export const ownerClaimPlan = async (deps: AuthDeps): Promise<ClaimPlan> => planOwnerClaim(await claimedOwnerOf(deps));

export const claimRaceWinnerOf = async (deps: AuthDeps, refusal: AppError): Promise<ClaimedOwner | null> =>
  claimRaceWinner(refusal, await claimedOwnerOf(deps));

export const startsAtSetup = async (deps: AuthDeps): Promise<boolean> =>
  (await ownerNeedsSetup(deps)) && !(await deps.users.listAll()).some(isActiveUser);

export const ownerNeedsSetup = async (deps: AuthDeps): Promise<boolean> =>
  isNeverClaimed(await deps.users.findById(OWNER_USER_ID));
