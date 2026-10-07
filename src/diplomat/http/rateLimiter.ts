/** In-process sliding-window attempt limiter (ADR-033 §2). Process-local on purpose: one process serves
 *  an instance (ADR-024), so there is nothing to share. */
export type RateLimiter = {
  isLimited: (key: string) => boolean;
  /** Count one failed attempt. */
  recordFailure: (key: string) => void;
  /** Forget a key — a successful login clears its username's strikes. */
  reset: (key: string) => void;
  /** Take back the most recent strike — an attempt that turned out not to be a failed guess. */
  forgive: (key: string) => void;
};

// A cap on tracked keys: an attacker spraying random usernames must not be able to grow this without bound.
const MAX_TRACKED_KEYS = 10_000;

export const createRateLimiter = (options: {
  windowMs: number;
  maxFailures: number;
  now: () => number;
}): RateLimiter => {
  const failures = new Map<string, number[]>();

  const recent = (key: string): number[] => {
    const cutoff = options.now() - options.windowMs;
    const kept = (failures.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  };

  return {
    isLimited: (key) => recent(key).length >= options.maxFailures,
    recordFailure: (key) => {
      const kept = recent(key);
      if (kept.length === 0 && failures.size >= MAX_TRACKED_KEYS) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      failures.set(key, [...kept, options.now()]);
    },
    reset: (key) => {
      failures.delete(key);
    },
    forgive: (key) => {
      const kept = recent(key).slice(0, -1);
      if (kept.length === 0) failures.delete(key);
      else failures.set(key, kept);
    },
  };
};

const MINUTE_MS = 60_000;
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * MINUTE_MS;
export const MAX_FAILURES_PER_IP = 20;
export const MAX_FAILURES_PER_USERNAME = 5;

const ipKey = (ip: string): string => `ip:${ip}`;
const usernameKey = (username: string): string => `username:${username}`;

/** The two limiters login and setup share semantics for: failures per client IP and per submitted
 *  username (counted whether or not that username exists, so the limiter reveals nothing about it). */
export type AttemptLimiter = {
  isLimited: (ip: string, username: string) => boolean;
  /** Counts a strike. Callers take it BEFORE the (slow, awaited) verification and settle it afterwards, so a
   *  burst of concurrent attempts is counted as it arrives instead of all passing `isLimited` together. */
  recordFailure: (ip: string, username: string) => void;
  /** The attempt succeeded: its username's strikes are cleared and its own IP strike is taken back. */
  recordSuccess: (ip: string, username: string) => void;
  /** The attempt was not a failed guess (e.g. a conflict): take its strike back. */
  forgive: (ip: string, username: string) => void;
};

export const createAttemptLimiter = (now: () => number = Date.now): AttemptLimiter => {
  const perIp = createRateLimiter({ windowMs: LOGIN_ATTEMPT_WINDOW_MS, maxFailures: MAX_FAILURES_PER_IP, now });
  const perUsername = createRateLimiter({
    windowMs: LOGIN_ATTEMPT_WINDOW_MS,
    maxFailures: MAX_FAILURES_PER_USERNAME,
    now,
  });
  return {
    isLimited: (ip, username) => perIp.isLimited(ipKey(ip)) || perUsername.isLimited(usernameKey(username)),
    recordFailure: (ip, username) => {
      perIp.recordFailure(ipKey(ip));
      perUsername.recordFailure(usernameKey(username));
    },
    recordSuccess: (ip, username) => {
      perUsername.reset(usernameKey(username));
      perIp.forgive(ipKey(ip));
    },
    forgive: (ip, username) => {
      perIp.forgive(ipKey(ip));
      perUsername.forgive(usernameKey(username));
    },
  };
};
