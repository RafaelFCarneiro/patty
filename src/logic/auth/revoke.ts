import type { Persistable } from '@rfc0/effect-runner';
import * as R from 'remeda';
import * as persistence from '../persistence.js';
import { ACCESS_TOKEN_ENTITY_TAG, SESSION_ENTITY_TAG } from '../../models/auth/entity.js';
import type { SessionEntity } from '../../models/auth/session.js';
import type { AccessTokenEntity } from '../../models/auth/token.js';
import type { RevokedCredentials } from '../../models/auth/users.js';
import { isLiveToken, revokedToken } from './token.js';

export const removeSession = (session: SessionEntity): Persistable =>
  persistence.remove({ entity: SESSION_ENTITY_TAG, id: session.id, version: session.version });

/**
 * Everything that lets a user in, ended together: every session is deleted and every still-live token — personal
 * access tokens and stdio sign-ins alike — is revoked (the row is kept, so the list still shows what existed).
 * Written to run in the SAME batch as the change that makes it necessary (a disable, a password reset), so there
 * is no instant at which the user is gone but a credential still works.
 */
export const endingCredentials = (
  held: { sessions: readonly SessionEntity[]; tokens: readonly AccessTokenEntity[] },
  now: Date,
): { persist: Persistable[]; revoked: RevokedCredentials } => {
  const live = R.filter(held.tokens, isLiveToken(now));
  return {
    persist: [
      ...R.map(held.sessions, removeSession),
      ...R.map(live, (token) =>
        persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: revokedToken(token, now) }),
      ),
    ],
    revoked: { sessionsEnded: held.sessions.length, tokensRevoked: live.length },
  };
};
