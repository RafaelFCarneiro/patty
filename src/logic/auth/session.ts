import { type UserEntity } from '../../models/auth/owner.js';
import { PrincipalVia, type Principal } from '../../models/auth/principal.js';
import { ALL_SCOPES } from '../../models/auth/scope.js';
import {
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  type SessionEntity,
  type SessionVerdict,
} from '../../models/auth/session.js';
import { hasCredentials } from './owner.js';
import { millis, toIso } from './time.js';

/** Idle expiry, capped so a session can never outlive its absolute maximum. */
export const slidingExpiry = (createdAt: string, now: Date): string =>
  toIso(Math.min(now.getTime() + SESSION_IDLE_TTL_MS, millis(createdAt) + SESSION_ABSOLUTE_MAX_MS));

export const newSession = (fields: { id: string; userId: string; tokenHash: string }, now: Date) => ({
  ...fields,
  createdAt: now.toISOString(),
  lastSeenAt: now.toISOString(),
  expiresAt: slidingExpiry(now.toISOString(), now),
});

export const isSessionExpired = (session: SessionEntity, now: Date): boolean =>
  now.getTime() >= millis(session.expiresAt) || now.getTime() >= millis(session.createdAt) + SESSION_ABSOLUTE_MAX_MS;

export const isStale = (session: SessionEntity, now: Date): boolean =>
  now.getTime() - millis(session.lastSeenAt) >= SESSION_TOUCH_INTERVAL_MS;

/** Slide the window forward — same row, later `last_seen_at`/`expires_at`. */
export const touched = (session: SessionEntity, now: Date): SessionEntity => ({
  ...session,
  lastSeenAt: now.toISOString(),
  expiresAt: slidingExpiry(session.createdAt, now),
});

/** A signed-in user acting through the browser: every scope (the session is the owner's own). */
export const sessionPrincipal = (user: UserEntity, session: SessionEntity): Principal => ({
  userId: user.id,
  sessionId: session.id,
  role: user.role,
  scopes: [...ALL_SCOPES],
  via: PrincipalVia.enum.session,
});

export const evaluateSession = (session: SessionEntity, user: UserEntity | null, now: Date): SessionVerdict =>
  isSessionExpired(session, now) || user === null || !hasCredentials(user) || user.disabledAt !== null
    ? { kind: 'invalid' }
    : { kind: 'valid', touch: isStale(session, now) };
