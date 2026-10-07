/** The browser session cookie (ADR-033 §2). One name, used by the hook that reads it and the routes that
 *  set and clear it. */
export const SESSION_COOKIE_NAME = 'fintrack_session';

const COOKIE_PAIR_SEPARATOR = ';';
const COOKIE_VALUE_SEPARATOR = '=';
const SECOND_MS = 1000;

/** The value of cookie `name` in a `Cookie` request header, or `undefined`. Session tokens are base64url,
 *  so no percent-decoding is needed — and none is done, so an encoded lookalike never matches. */
export const readCookie = (header: string | undefined, name: string): string | undefined =>
  header
    ?.split(COOKIE_PAIR_SEPARATOR)
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${name}${COOKIE_VALUE_SEPARATOR}`))
    ?.slice(name.length + COOKIE_VALUE_SEPARATOR.length);

type CookieOptions = { secure: boolean; maxAgeMs: number };

// HttpOnly: no script can read it. SameSite=Lax: not sent on cross-site POSTs (CSRF layer one — the
// Origin check is layer two). Secure only over https: a Secure cookie is dropped by browsers on plain
// http, which would break login on loopback.
const serialize = (value: string, { secure, maxAgeMs }: CookieOptions): string =>
  [
    `${SESSION_COOKIE_NAME}${COOKIE_VALUE_SEPARATOR}${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / SECOND_MS))}`,
    ...(secure ? ['Secure'] : []),
  ].join(`${COOKIE_PAIR_SEPARATOR} `);

export const sessionCookie = (token: string, expiresAtIso: string, secure: boolean, now: Date): string =>
  serialize(token, { secure, maxAgeMs: Date.parse(expiresAtIso) - now.getTime() });

export const clearedSessionCookie = (secure: boolean): string => serialize('', { secure, maxAgeMs: 0 });
