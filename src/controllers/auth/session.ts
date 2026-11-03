import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../../common/errors.js';
import { okOr } from '../../common/result.js';
import { canLogin } from '../../logic/auth/password.js';
import { evaluateSession, newSession, sessionPrincipal, touched } from '../../logic/auth/session.js';
import { removeSession } from '../../logic/auth/revoke.js';
import { loggedIn } from '../../logic/auth/users.js';
import * as persistence from '../../logic/persistence.js';
import { SESSION_ENTITY_TAG, USER_ENTITY_TAG } from '../../models/auth/entity.js';
import { authErrors } from '../../models/auth/errors.js';
import type { LoginInput } from '../../models/auth/password.js';
import type { Principal } from '../../models/auth/principal.js';
import type { StartedSession } from '../../models/auth/session.js';
import type { AuthDeps } from '../deps.js';

export const startSession = (deps: AuthDeps, userId: string, now: Date) => {
  const token = deps.secrets.randomToken();
  const session = newSession({ id: deps.newId(), userId, tokenHash: deps.secrets.hashSecret(token) }, now);
  const persistable = persistence.insert({ entity: SESSION_ENTITY_TAG, model: session });
  const started: StartedSession = { token, expiresAt: session.expiresAt };
  return { persistable, started };
};

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
