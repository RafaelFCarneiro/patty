import { z } from 'zod';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { Id } from '../id.js';
import { DAY_MS, MINUTE_MS } from './time.js';

/** A session dies after this long without being seen (sliding)… */
export const SESSION_IDLE_TTL_MS = 7 * DAY_MS;
/** `last_seen_at`/`expires_at` are rewritten at most this often — not on every request. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * MINUTE_MS;
/** A session never outlives this, however active — also the browser cookie's lifetime (the server's sliding
 *  idle expiry decides validity; the cookie just must not expire before the server would). */
export const SESSION_ABSOLUTE_MAX_MS = 30 * DAY_MS;

export const SessionEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    userId: Id,
    tokenHash: z.string().describe('sha256 of the session token — the token itself is never stored'),
    createdAt: z.string(),
    lastSeenAt: z.string(),
    expiresAt: z.string(),
  }),
);
export type SessionEntity = z.infer<typeof SessionEntitySchema>;

/** A freshly started session — the plaintext token goes to the cookie and nowhere else. */
export type StartedSession = { token: string; expiresAt: string };

/** Whether a session or token is still good, and whether its `last_seen`/`last_used` is stale enough to rewrite. */
export type SessionVerdict = { kind: 'invalid' } | { kind: 'valid'; touch: boolean };
