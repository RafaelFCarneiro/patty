import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HTML_CONTENT_TYPE } from './ui-files.js';

/** Server-rendered, form-posting pages (the sign-in pages and the token pages): one set of headers and one
 *  urlencoded parser, so no page can be a little less locked down than its neighbour. */

export const FORM_BODY_LIMIT_BYTES = 8 * 1024;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

// These pages are tiny, self-contained and framed by nobody: lock everything down (no scripts, no
// third-party loads, no embedding) and never let a proxy or the back button keep a copy.
const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  // A dashboard script runs in this same origin; without this it could `window.open` one of these pages, keep the
  // handle, and read the form or the one-time token. Same-origin COOP puts the page in its own browsing context group.
  'cross-origin-opener-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
} as const;

/**
 * A page whose URL carries a secret (an invite code) must not leak it through `Referer`: `strict-origin` sends
 * the origin and never the path or query. Deliberately not `no-referrer` — with that policy a browser sends
 * `Origin: null` on the page's own form POST, which the CSRF origin check (rightly) cannot accept.
 */
export const SECRET_URL_HEADERS = { 'referrer-policy': 'strict-origin' } as const;

export const page = (
  reply: FastifyReply,
  status: number,
  html: string,
  overrides: Readonly<Record<string, string>> = {},
): FastifyReply =>
  reply
    .status(status)
    .headers({ ...PAGE_HEADERS, ...overrides })
    .type(HTML_CONTENT_TYPE)
    .send(html);

// An urlencoded body is only parsed in the scopes that call `addFormParser` — never app-wide, so `/api` keeps
// rejecting it.
const parseFormBody = (_req: FastifyRequest, body: string, done: (err: Error | null, value?: unknown) => void) => {
  done(null, Object.fromEntries(new URLSearchParams(body)));
};

export const addFormParser = (scope: FastifyInstance): void =>
  scope.addContentTypeParser(FORM_CONTENT_TYPE, { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT_BYTES }, parseFormBody);
