import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { AppError } from '../../common/errors.js';
import { okOr } from '../../common/result.js';
import { hasCredentials } from '../../logic/auth/owner.js';
import { withPasswordHash } from '../../logic/auth/password.js';
import { endingCredentials } from '../../logic/auth/revoke.js';
import { withCredentialsChanged } from '../../logic/auth/users.js';
import * as persistence from '../../logic/persistence.js';
import { USER_ENTITY_TAG } from '../../models/auth/entity.js';
import { authErrors } from '../../models/auth/errors.js';
import { type ClaimedUserEntity, OWNER_USER_ID } from '../../models/auth/owner.js';
import type { PasswordReset, ResetPasswordInput } from '../../models/auth/password.js';
import type { AuthDeps } from '../deps.js';

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
