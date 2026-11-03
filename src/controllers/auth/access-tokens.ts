import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { liveSessionOf } from '../../logic/auth/session.js';
import { withCredentialsChanged } from '../../logic/auth/users.js';
import {
  evaluateToken,
  newAccessToken,
  revokedToken,
  summarizeToken,
  tokenDisplayPrefix,
  tokenPrincipal,
  usedToken,
} from '../../logic/auth/token.js';
import * as persistence from '../../logic/persistence.js';
import { ACCESS_TOKEN_ENTITY_TAG, SESSION_ENTITY_TAG, USER_ENTITY_TAG } from '../../models/auth/entity.js';
import { authErrors } from '../../models/auth/errors.js';
import { type Principal, PrincipalVia } from '../../models/auth/principal.js';
import {
  AccessTokenKind,
  type AccessTokenSummary,
  type CreateTokenInput,
  type CreatedAccessToken,
} from '../../models/auth/token.js';
import type { AuthDeps } from '../deps.js';
import { confirmedUser } from './step-up.js';

export const createToken = (
  deps: AuthDeps,
  principal: Principal,
  input: CreateTokenInput,
): ResultAsync<FlowOutcome<CreatedAccessToken>, AppError> =>
  safeTry(async function* () {
    const userId = principal.userId;
    const user = await deps.users.findById(userId);
    const account = yield* okOr(await confirmedUser(deps, user, input.password), authErrors.invalidCredentials);

    yield* guard(principal.via === PrincipalVia.enum.session, authErrors.sessionRequired);
    const now = deps.clock();
    const session = yield* okOr(
      liveSessionOf(await deps.sessions.listByUser(userId), principal.sessionId, now),
      authErrors.unauthenticated,
    );
    const token = deps.secrets.randomAccessToken();
    const entity = newAccessToken(
      { id: deps.newId(), userId, tokenHash: deps.secrets.hashSecret(token), prefix: tokenDisplayPrefix(token), input },
      now,
    );
    const persist: Persistable[] = [
      persistence.check({ entity: SESSION_ENTITY_TAG, id: session.id, version: session.version }),
      persistence.update({ entity: USER_ENTITY_TAG, model: withCredentialsChanged(account, now) }),
      persistence.insert({ entity: ACCESS_TOKEN_ENTITY_TAG, model: entity }),
    ];
    return ok({ persist, response: { token, summary: summarizeToken(entity, now) } });
  });

export const listTokens = async (deps: AuthDeps, userId: string): Promise<AccessTokenSummary[]> => {
  const now = deps.clock();
  return R.map(await deps.accessTokens.listByUser(userId), (token) => summarizeToken(token, now));
};

export const revokeToken = (deps: AuthDeps, userId: string, id: string): ResultAsync<FlowOutcome<void>, AppError> =>
  safeTry(async function* () {
    const token = yield* okOr(await deps.accessTokens.findById(userId, id), authErrors.unknownToken(id));
    const persist: Persistable[] =
      token.revokedAt === null
        ? [persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: revokedToken(token, deps.clock()) })]
        : [];
    return ok({ persist, response: undefined });
  });

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
