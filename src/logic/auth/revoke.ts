import type { Persistable } from '@rfc0/effect-runner';
import * as R from 'remeda';
import * as persistence from '../persistence.js';
import { ACCESS_TOKEN_ENTITY_TAG, CLIENT_GRANT_ENTITY_TAG, SESSION_ENTITY_TAG } from '../../models/auth/entity.js';
import { GrantStatus } from '../../models/auth/grant.js';
import type { SessionEntity } from '../../models/auth/session.js';
import type { RevokedCredentials, HeldCredentials } from '../../models/auth/users.js';
import { expiredGrant } from './grant.js';
import { isLiveToken, revokedToken } from './token.js';

export const removeSession = (session: SessionEntity): Persistable =>
  persistence.remove({ entity: SESSION_ENTITY_TAG, id: session.id, version: session.version });

export const endedCredentials = (held: HeldCredentials, now: Date) => {
  const tokens = R.pipe(
    held.tokens,
    R.filter(isLiveToken(now)),
    R.map((token) => revokedToken(token, now)),
  );
  const expiredGrants = R.pipe(
    held.approvedGrants,
    R.filter((grant) => grant.status === GrantStatus.enum.approved),
    R.map(expiredGrant),
  );
  return {
    sessions: [...held.sessions],
    tokens,
    expiredGrants,
    revoked: { sessionsEnded: held.sessions.length, tokensRevoked: tokens.length } satisfies RevokedCredentials,
  };
};

export const endingCredentials = (
  held: HeldCredentials,
  now: Date,
): { persist: Persistable[]; revoked: RevokedCredentials } => {
  const ended = endedCredentials(held, now);
  return {
    persist: [
      ...R.map(ended.sessions, removeSession),
      ...R.map(ended.tokens, (token) => persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: token })),
      ...R.map(ended.expiredGrants, (grant) => persistence.update({ entity: CLIENT_GRANT_ENTITY_TAG, model: grant })),
    ],
    revoked: ended.revoked,
  };
};
