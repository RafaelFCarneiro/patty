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

export type HeldCredentials = { sessions: readonly SessionEntity[]; tokens: readonly AccessTokenEntity[] };

/**
 * The one rule for ending everything that lets a user in: every session goes, and every still-live token — personal
 * access tokens and stdio sign-ins alike — comes back revoked (the row is kept, so the list still shows what existed).
 * Meant to run in the SAME batch as the change that makes it necessary (a disable, a password reset), so there is no
 * instant at which the user is gone but a credential still works.
 */
export const endedCredentials = (held: HeldCredentials, now: Date) => {
  const tokens = R.pipe(
    held.tokens,
    R.filter(isLiveToken(now)),
    R.map((token) => revokedToken(token, now)),
  );
  return {
    sessions: [...held.sessions],
    tokens,
    revoked: { sessionsEnded: held.sessions.length, tokensRevoked: tokens.length } satisfies RevokedCredentials,
  };
};

/** `endedCredentials` as the writes that apply it: a session `delete` and a token `update` each. */
export const endingCredentials = (
  held: HeldCredentials,
  now: Date,
): { persist: Persistable[]; revoked: RevokedCredentials } => {
  const ended = endedCredentials(held, now);
  return {
    persist: [
      ...R.map(ended.sessions, removeSession),
      ...R.map(ended.tokens, (token) => persistence.update({ entity: ACCESS_TOKEN_ENTITY_TAG, model: token })),
    ],
    revoked: ended.revoked,
  };
};
